const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Determine uploads directory based on environment
// On Vercel/serverless, use /tmp (writable), otherwise use local uploads folder
const isVercel = process.env.VERCEL_ENV || process.env.VERCEL;
const isServerless = process.env.AWS_LAMBDA_FUNCTION_NAME || isVercel;

const uploadsDir = isServerless 
  ? path.join(os.tmpdir(), 'uploads') // Use /tmp on serverless
  : path.join(__dirname, '../uploads'); // Use local folder for development

// Create uploads directory if it doesn't exist (only if we can write)
try {
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }
} catch (error) {
  // If directory creation fails, log but don't crash
  // On serverless, /tmp should already exist
  console.warn('Could not create uploads directory:', error.message);
}

// Configure multer for file storage
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDir);
  },
  filename: function (req, file, cb) {
    // Generate unique filename: timestamp-randomnumber-originalname
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

// File filter - accept only certain file types
const fileFilter = (req, file, cb) => {
  // Allow images, PDFs, and common document types
  const allowedTypes = /jpeg|jpg|png|gif|pdf|doc|docx|txt/;
  const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
  const mimetype = allowedTypes.test(file.mimetype);

  if (mimetype && extname) {
    return cb(null, true);
  } else {
    cb(new Error('Only image files, PDFs, and documents are allowed!'));
  }
};

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  },
  fileFilter: fileFilter
});

module.exports = upload;

