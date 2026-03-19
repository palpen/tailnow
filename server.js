const express = require('express');
const multer = require('multer');
const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 8080;
const SITES_DIR = path.join(__dirname, 'sites');

// Ensure sites directory exists
if (!fs.existsSync(SITES_DIR)) {
    fs.mkdirSync(SITES_DIR, { recursive: true });
}

// SECURITY: Limit upload size to 100MB to prevent DoS via disk exhaustion
// Use OS temp directory instead of local uploads/ folder to keep the app clean
const upload = multer({ 
    dest: os.tmpdir(),
    limits: { fileSize: 100 * 1024 * 1024 } 
});

// Serve static files from the sites directory
app.use(express.static(SITES_DIR));

// API Endpoint to publish a new site
app.post('/api/publish/:project', upload.single('file'), (req, res) => {
    const { project } = req.params;
    const file = req.file;

    // Helper to safely clean up uploaded files
    const cleanupFile = () => {
        if (file && fs.existsSync(file.path)) {
            fs.unlinkSync(file.path);
        }
    };
    
    if (!file) {
        return res.status(400).json({ error: 'No zip file provided' });
    }

    // SECURITY: Strict regex to prevent Directory Traversal attacks
    if (!/^[a-zA-Z0-9_-]+$/.test(project)) {
        cleanupFile();
        return res.status(400).json({ error: 'Invalid project name. Only alphanumeric, hyphens, and underscores allowed.' });
    }

    const projectDir = path.join(SITES_DIR, project);

    try {
        const zip = new AdmZip(file.path);
        
        // SECURITY: Zip Slip Prevention
        for (const entry of zip.getEntries()) {
            if (entry.entryName.includes('..')) {
                cleanupFile();
                return res.status(400).json({ error: 'Security violation: Zip Slip attempt detected.' });
            }
        }

        // Clean existing directory if it exists
        if (fs.existsSync(projectDir)) {
            fs.rmSync(projectDir, { recursive: true, force: true });
        }

        // Extract the uploaded zip file
        zip.extractAllTo(projectDir, true);
        cleanupFile();

        res.json({
            success: true,
            project,
            message: `Successfully published to /${project}`,
            url: `https://${req.headers.host}/${project}/`
        });
    } catch (err) {
        console.error('Error publishing site:', err);
        cleanupFile();
        res.status(500).json({ error: 'Failed to extract and publish site' });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Tailnow server running at http://localhost:${PORT}`);
    console.log(`📁 Hosting files from: ${SITES_DIR}`);
    console.log(`\nTo expose this to your Tailnet, run:\ntailscale serve --bg ${PORT}`);
});
