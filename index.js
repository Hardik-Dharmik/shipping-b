require('dotenv').config();
const express = require("express");
const cors = require("cors");
const supabase = require("./supabase");
const registerRoutes = require("./routes/register");
const authRoutes = require("./routes/auth");
const adminRoutes = require("./routes/admin");

const app = express();
const PORT = process.env.PORT || 5000;

// middlewares
app.use(cors());

// Body parsing - only parse JSON (skip multipart/form-data for file uploads)
app.use(express.json({
  type: ['application/json', 'text/json']
}));

// URL encoded parsing - only parse urlencoded (skip multipart)
app.use(express.urlencoded({ 
  extended: true,
  type: ['application/x-www-form-urlencoded']
}));

// Routes
app.use("/api/register", registerRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/admin", adminRoutes);

// test route
app.get("/", (req, res) => {
  res.send("Express backend is running 🚀");
});

// Example Supabase route - test database connection
app.get("/api/test-supabase", async (req, res) => {
  try {
    // Example: Fetch from a table (adjust table name as needed)
    // const { data, error } = await supabase.from('your_table').select('*').limit(1);
    
    // For now, just test the connection
    res.json({ 
      success: true, 
      message: "Supabase client initialized successfully",
      supabaseUrl: process.env.SUPABASE_URL ? "Configured" : "Not configured"
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// start server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
