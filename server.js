const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const jsPDF = require('jspdf').jsPDF;

const app = express();
const PORT = 3000;

// Domain configuration (default to localhost, can be updated via API)
let domainConfig = {
  domain: 'localhost:3000'
};

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

// Database setup
const inventoryDb = new sqlite3.Database('./db/inventory.db');
const transactionsDb = new sqlite3.Database('./db/transactions.db');

// Initialize databases
inventoryDb.serialize(() => {
  inventoryDb.run(`
    CREATE TABLE IF NOT EXISTS materials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      unit TEXT NOT NULL,
      quantity REAL NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Insert initial materials if they don't exist
  const initialMaterials = [
    { name: 'Wood Panels', unit: 'pieces', quantity: 5 },
    { name: 'PVC Cables', unit: 'meters', quantity: 5 },
    { name: '3D Filament', unit: 'kg', quantity: 5 }
  ];

  initialMaterials.forEach(material => {
    inventoryDb.run(
      'INSERT OR IGNORE INTO materials (name, unit, quantity) VALUES (?, ?, ?)',
      [material.name, material.unit, material.quantity]
    );
  });
});

transactionsDb.serialize(() => {
  transactionsDb.run(`
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      material_name TEXT NOT NULL,
      user_name TEXT NOT NULL,
      user_email TEXT NOT NULL,
      action TEXT NOT NULL,
      quantity REAL NOT NULL,
      timestamp TEXT NOT NULL
    )
  `);
});

// API Routes

// Get all materials
app.get('/api/materials', (req, res) => {
  inventoryDb.all('SELECT * FROM materials ORDER BY name', [], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
});

// Get specific material by name
app.get('/api/materials/:name', (req, res) => {
  const materialName = decodeURIComponent(req.params.name);
  inventoryDb.get(
    'SELECT * FROM materials WHERE name = ?',
    [materialName],
    (err, row) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      if (!row) {
        return res.status(404).json({ error: 'Material not found' });
      }
      res.json(row);
    }
  );
});

// Add new material
app.post('/api/materials', (req, res) => {
  const { name, unit, quantity } = req.body;

  if (!name || !unit || quantity === undefined) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  inventoryDb.run(
    'INSERT INTO materials (name, unit, quantity) VALUES (?, ?, ?)',
    [name, unit, quantity],
    function(err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json({ id: this.lastID, name, unit, quantity });
    }
  );
});

// Update material quantity
app.put('/api/materials/:name', (req, res) => {
  const materialName = decodeURIComponent(req.params.name);
  const { quantity } = req.body;

  if (quantity === undefined) {
    return res.status(400).json({ error: 'Quantity is required' });
  }

  inventoryDb.run(
    'UPDATE materials SET quantity = ? WHERE name = ?',
    [quantity, materialName],
    function(err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      if (this.changes === 0) {
        return res.status(404).json({ error: 'Material not found' });
      }
      res.json({ success: true, materialName, quantity });
    }
  );
});

// Delete material
app.delete('/api/materials/:name', (req, res) => {
  const materialName = decodeURIComponent(req.params.name);

  inventoryDb.run(
    'DELETE FROM materials WHERE name = ?',
    [materialName],
    function(err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      if (this.changes === 0) {
        return res.status(404).json({ error: 'Material not found' });
      }
      res.json({ success: true });
    }
  );
});

// Submit transaction (check-in/check-out)
app.post('/api/transactions', (req, res) => {
  const { materialName, userName, userEmail, action, quantity } = req.body;

  if (!materialName || !userName || !userEmail || !action || !quantity) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // First, get current material quantity
  inventoryDb.get(
    'SELECT quantity FROM materials WHERE name = ?',
    [materialName],
    (err, row) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      if (!row) {
        return res.status(404).json({ error: 'Material not found' });
      }

      const currentQuantity = row.quantity;
      let newQuantity;

      if (action === 'check-out') {
        if (quantity > currentQuantity) {
          return res.status(400).json({ 
            error: `Insufficient quantity. Only ${currentQuantity} available.` 
          });
        }
        newQuantity = currentQuantity - quantity;
      } else if (action === 'check-in') {
        newQuantity = currentQuantity + quantity;
      } else {
        return res.status(400).json({ error: 'Invalid action' });
      }

      // Update inventory
      inventoryDb.run(
        'UPDATE materials SET quantity = ? WHERE name = ?',
        [newQuantity, materialName],
        (err) => {
          if (err) {
            return res.status(500).json({ error: err.message });
          }

          // Record transaction
          const estDate = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
          transactionsDb.run(
            `INSERT INTO transactions (material_name, user_name, user_email, action, quantity, timestamp)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [materialName, userName, userEmail, action, quantity, estDate],
            function(err) {
              if (err) {
                return res.status(500).json({ error: err.message });
              }
              res.json({
                success: true,
                transactionId: this.lastID,
                newQuantity
              });
            }
          );
        }
      );
    }
  );
});

// Get all transactions
app.get('/api/transactions', (req, res) => {
  transactionsDb.all(
    'SELECT * FROM transactions ORDER BY timestamp DESC',
    [],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json(rows);
    }
  );
});

// Get transactions for a specific material
app.get('/api/transactions/:materialName', (req, res) => {
  const materialName = decodeURIComponent(req.params.materialName);
  transactionsDb.all(
    'SELECT * FROM transactions WHERE material_name = ? ORDER BY timestamp DESC',
    [materialName],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json(rows);
    }
  );
});

// QR Code endpoints

// Get domain configuration
app.get('/api/config/domain', (req, res) => {
  res.json(domainConfig);
});

// Update domain configuration
app.put('/api/config/domain', (req, res) => {
  const { domain } = req.body;
  if (!domain) {
    return res.status(400).json({ error: 'Domain is required' });
  }
  domainConfig.domain = domain;
  res.json({ success: true, domain: domainConfig.domain });
});

// Generate QR code for a single material
app.get('/api/qr/:materialName', async (req, res) => {
  const materialName = decodeURIComponent(req.params.materialName);
  const materialUrl = `http://${domainConfig.domain}/material/${encodeURIComponent(materialName)}`;
  
  try {
    const qrImage = await QRCode.toDataURL(materialUrl, {
      width: 200,
      margin: 2,
      color: {
        dark: '#000000',
        light: '#FFFFFF'
      }
    });
    res.json({ qrCode: qrImage, url: materialUrl });
  } catch (error) {
    res.status(500).json({ error: 'Failed to generate QR code' });
  }
});

// Generate QR code as PNG file
app.get('/api/qr/:materialName/download', async (req, res) => {
  const materialName = decodeURIComponent(req.params.materialName);
  const materialUrl = `http://${domainConfig.domain}/material/${encodeURIComponent(materialName)}`;
  
  try {
    const qrImage = await QRCode.toBuffer(materialUrl, {
      width: 200,
      margin: 2,
      color: {
        dark: '#000000',
        light: '#FFFFFF'
      }
    });
    
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', `attachment; filename="QR_${materialName.replace(/\s+/g, '_')}.png"`);
    res.send(qrImage);
  } catch (error) {
    res.status(500).json({ error: 'Failed to generate QR code' });
  }
});

// Generate PDF with all material QR codes
app.get('/api/qr/all/pdf', async (req, res) => {
  try {
    // Get all materials
    inventoryDb.all('SELECT * FROM materials ORDER BY name', [], async (err, materials) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }

      try {
        // Create PDF
        const doc = new jsPDF({
          orientation: 'portrait',
          unit: 'mm',
          format: 'a4'
        });

        let yPosition = 20;
        const pageHeight = doc.internal.pageSize.getHeight();

        for (const material of materials) {
          // Check if we need a new page
          if (yPosition > pageHeight - 80) {
            doc.addPage();
            yPosition = 20;
          }

          // Generate QR code
          const materialUrl = `http://${domainConfig.domain}/material/${encodeURIComponent(material.name)}`;
          const qrImage = await QRCode.toDataURL(materialUrl, {
            width: 200,
            margin: 2,
            color: {
              dark: '#000000',
              light: '#FFFFFF'
            }
          });

          // Add QR code to PDF
          doc.addImage(qrImage, 'PNG', 30, yPosition, 60, 60);

          // Add material info
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(12);
          doc.text(`Material: ${material.name}`, 100, yPosition + 10);
          doc.text(`Unit: ${material.unit}`, 100, yPosition + 20);
          doc.text(`Available: ${material.quantity}`, 100, yPosition + 30);

          yPosition += 80;
        }

        // Send PDF
        const pdfBuffer = Buffer.from(doc.output('arraybuffer'));
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'attachment; filename="BDW_Material_QR_Codes.pdf"');
        res.send(pdfBuffer);
      } catch (innerError) {
        console.error('Error generating PDF:', innerError);
        res.status(500).json({ error: 'Failed to generate PDF', details: innerError.message });
      }
    });
  } catch (error) {
    console.error('Error in PDF endpoint:', error);
    res.status(500).json({ error: 'Failed to generate PDF' });
  }
});

// Serve HTML pages
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/history', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'history.html'));
});

// Dynamic material pages
app.get('/material/:name', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'material.html'));
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Brown Design Workshop Material Circulation Station`);
  console.log(`📍 Server running at http://localhost:${PORT}`);
  console.log(`📦 Database initialized with 3 materials`);
});
