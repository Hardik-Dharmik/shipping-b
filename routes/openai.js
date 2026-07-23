const express = require("express");
const router = express.Router();
const OpenAI = require("openai");
const { authenticateToken } = require('./auth');
const multer = require('multer');
const path = require('path');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|pdf|doc|docx|txt/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);

    if (mimetype && extname) {
      return cb(null, true);
    }

    cb(new Error('Only images, PDFs, and documents are allowed!'));
  }
});

const SYSTEM_PROMPT = `
You are an expert OCR and logistics document parser.

Your task is to analyze the uploaded screenshot or document image and extract ONLY the shipper information.

Return ONLY valid JSON in the following format:

{
  "companyName": "",
  "address": "",
  "city": "",
  "postalCode": "",
  "phone": "",
  "contactPerson": "",
  "email": "",
  "confidence": 0
}

Rules:
- If a field is missing return null.
- Never guess.
- Preserve original text.
- Do not return markdown.
- Do not explain anything.
`;

router.post(
  "/extract-text",
  authenticateToken,
  upload.fields([
    {
      name: "screenshot",
      maxCount: 1,
    },
  ]),
  async (req, res) => {
    try {
      const screenshot = req.files?.screenshot?.[0];

      if (!screenshot) {
        return res.status(400).json({
          success: false,
          error: "Screenshot is required.",
        });
      }

      const imageBase64 = screenshot.buffer.toString("base64");
    //   console.log(imageBase64);

      const response = await openai.responses.create({
  model: "gpt-5",
  text: {
    format: {
      type: "json_schema",
      name: "shipper_details",
      schema: {
        type: "object",
        properties: {
          companyName: { type: ["string", "null"] },
          address: { type: ["string", "null"] },
          city: { type: ["string", "null"] },
          postalCode: { type: ["string", "null"] },
          phone: { type: ["string", "null"] },
          contactPerson: { type: ["string", "null"] },
          email: { type: ["string", "null"] },
          confidence: { type: "number" }
        },
        required: [
          "companyName",
          "address",
          "city",
          "postalCode",
          "phone",
          "contactPerson",
          "email",
          "confidence"
        ],
        additionalProperties: false
      }
    }
  },
  input: [
    {
      role: "system",
      content: SYSTEM_PROMPT
    },
    {
      role: "user",
      content: [
        {
          type: "input_text",
          text: "Extract shipper details."
        },
        {
          type: "input_image",
          image_url: `data:${screenshot.mimetype};base64,${imageBase64}`
        }
      ]
    }
  ]
});

const data = JSON.parse(response.output_text);
console.log(data)
      

      return res.status(200).json({
        success: true,
        message: "Shipper details extracted successfully.",
        data
      });
    } catch (error) {
      console.error("Text extraction error:", error);

      return res.status(500).json({
        success: false,
        error: error.message || "Failed to extract text.",
      });
    }
  }
);

module.exports = router;