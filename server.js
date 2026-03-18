const express = require('express');
const multer = require('multer');
const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;
const SITES_DIR = path.join(__dirname, 'sites');

// Ensure sites directory exists
if (!fs.existsSync(SITES_DIR)) {
    fs.mkdirSync(SITES_DIR, { recursive: true });
}

// SECURITY: Limit upload size to 100MB to prevent DoS via disk exhaustion
const upload = multer({ 
    dest: 'uploads/',
    limits: { fileSize: 100 * 1024 * 1024 } 
});

// Serve static files from the sites directory
app.use(express.static(SITES_DIR));

// API Endpoint to publish a new site
app.post('/api/publish/:project', upload.single('file'), (req, res) => {
    const project = req.params.project;
    
    // SECURITY: Strict regex to prevent Directory Traversal attacks (e.g., passing "../../etc")
    if (!/^[a-zA-Z0-9_-]+$/.test(project)) {
        if (req.file) fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: 'Invalid project name. Only alphanumeric, hyphens, and underscores allowed.' });
    }

    if (!req.file) {
        return res.status(400).json({ error: 'No zip file provided' });
    }

    const projectDir = path.join(SITES_DIR, project);

    try {
        const zip = new AdmZip(req.file.path);
        
        // SECURITY: Zip Slip Prevention. Ensure no file in the zip tries to navigate up directories.
        const zipEntries = zip.getEntries();
        for (const entry of zipEntries) {
            if (entry.entryName.includes('..')) {
                fs.unlinkSync(req.file.path);
                return res.status(400).json({ error: 'Security violation: Zip Slip attempt detected (path traversal within zip).' });
            }
        }

        // Clean existing directory if it exists
        if (fs.existsSync(projectDir)) {
            fs.rmSync(projectDir, { recursive: true, force: true });
        }

        // Extract the uploaded zip file
        zip.extractAllTo(projectDir, true);

        // Clean up the uploaded zip file
        fs.unlinkSync(req.file.path);

        res.json({
            success: true,
            project: project,
            message: `Successfully published to /${project}`,
            url: `https://${req.headers.host}/${project}/`
        });
    } catch (err) {
        console.error('Error publishing site:', err);
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ error: 'Failed to extract and publish site' });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Tailnow server running at http://localhost:${PORT}`);
    console.log(`📁 Hosting files from: ${SITES_DIR}`);
    console.log(`\nTo expose this to your Tailnet, run:`);
    console.log(`tailscale serve --bg ${PORT}`);
});
