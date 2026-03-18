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

// Configure multer for zip file uploads
const upload = multer({ dest: 'uploads/' });

// Serve static files from the sites directory
app.use(express.static(SITES_DIR));

// API Endpoint to publish a new site
app.post('/api/publish/:project', upload.single('file'), (req, res) => {
    const project = req.params.project;
    
    // Basic security check to prevent directory traversal
    if (!project || project.includes('..') || project.includes('/')) {
        return res.status(400).json({ error: 'Invalid project name' });
    }

    if (!req.file) {
        return res.status(400).json({ error: 'No zip file provided' });
    }

    const projectDir = path.join(SITES_DIR, project);

    try {
        // Clean existing directory if it exists
        if (fs.existsSync(projectDir)) {
            fs.rmSync(projectDir, { recursive: true, force: true });
        }

        // Extract the uploaded zip file
        const zip = new AdmZip(req.file.path);
        zip.extractAllTo(projectDir, true);

        // Clean up the uploaded zip file
        fs.unlinkSync(req.file.path);

        res.json({
            success: true,
            project: project,
            message: `Successfully published to /${project}`,
            url: `http://${req.hostname}/${project}/`
        });
    } catch (err) {
        console.error('Error publishing site:', err);
        res.status(500).json({ error: 'Failed to extract and publish site' });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Tailnow server running at http://localhost:${PORT}`);
    console.log(`📁 Hosting files from: ${SITES_DIR}`);
    console.log(`\nTo expose this to your Tailnet, run:`);
    console.log(`tailscale serve --bg ${PORT}`);
});
