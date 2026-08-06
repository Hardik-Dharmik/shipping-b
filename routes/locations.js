const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const { authenticateToken } = require('./auth');

const countryCodesPath = path.join(__dirname, '../data/countryCodes.json');
let countryCodes = [];

try {
  const raw = fs.readFileSync(countryCodesPath, 'utf8');
  countryCodes = JSON.parse(raw);
} catch (error) {
  console.error('Failed to load countryCodes.json:', error);
}

const parsePositiveInteger = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : NaN;
};

const buildGeoapifyUrl = ({ text, type, countrycode, limit, apiKey }) => {
  const params = new URLSearchParams();
  params.set('text', text);
  params.set('type', type);
  params.set('limit', String(limit));

  if (countrycode) {
    params.set('filter', `countrycode:${countrycode}`);
  }

  params.set('apiKey', apiKey);

  return `https://api.geoapify.com/v1/geocode/autocomplete?${params.toString()}`;
};

const normalizeQueryValue = (value, fallback = '') => String(value || '').trim();

const mapGeoapifyFeature = (feature) => {
  const properties = feature?.properties || {};

  return {
    formatted: properties.formatted || properties.name || '',
    city: properties.city || properties.town || properties.village || properties.county || '',
    state: properties.state || properties.province || '',
    country: properties.country || '',
    postcode: properties.postcode || '',
    latitude: properties.lat || properties.latitude || null,
    longitude: properties.lon || properties.longitude || null
  };
};

const fetchGeoapifySuggestions = async ({ text, type, countrycode, limit, apiKey }) => {
  const url = buildGeoapifyUrl({ text, type, countrycode, limit, apiKey });
  const response = await fetch(url);

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Geoapify request failed: ${response.status} ${response.statusText} - ${errorText}`);
  }

  const data = await response.json();

  if (!Array.isArray(data.features)) {
    throw new Error('Geoapify response format invalid');
  }

  return data.features.map(mapGeoapifyFeature);
};

const createSuggestionHandler = (type) => async (req, res) => {
  try {
    const text = normalizeQueryValue(req.query.text);
    const countrycode = normalizeQueryValue(req.query.countrycode, 'in') || 'in';
    const limit = parsePositiveInteger(req.query.limit, 10);
    const apiKey = process.env.GEOAPIFY_API_KEY;

    if (!text) {
      return res.status(400).json({
        success: false,
        error: 'text query parameter is required'
      });
    }

    if (!apiKey) {
      return res.status(500).json({
        success: false,
        error: 'Geoapify API key is not configured'
      });
    }

    if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
      return res.status(400).json({
        success: false,
        error: 'limit must be a positive integer between 1 and 20'
      });
    }

    const suggestions = await fetchGeoapifySuggestions({
      text,
      type,
      countrycode,
      limit,
      apiKey
    });

    return res.json({
      success: true,
      data: suggestions
    });
  } catch (error) {
    console.error(`Geoapify ${type} suggestions error:`, error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch suggestions'
    });
  }
};

const createCountrySuggestionHandler = async (req, res) => {
  try {
    const text = normalizeQueryValue(req.query.text);
    const limit = parsePositiveInteger(req.query.limit, 10);

    if (!text) {
      return res.status(400).json({
        success: false,
        error: 'text query parameter is required'
      });
    }

    if (!Array.isArray(countryCodes) || countryCodes.length === 0) {
      return res.status(500).json({
        success: false,
        error: 'Country codes data is not available'
      });
    }

    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      return res.status(400).json({
        success: false,
        error: 'limit must be a positive integer between 1 and 50'
      });
    }

    const normalizedText = text.toLowerCase();
    const filtered = countryCodes
      .map((country) => ({
        name: String(country.name || '').trim(),
        code: String(country.code || '').trim(),
        dial_code: String(country.dial_code || '').trim()
      }))
      .filter((country) => {
        const nameMatch = country.name.toLowerCase().includes(normalizedText);
        const codeMatch = country.code.toLowerCase().includes(normalizedText);
        const dialMatch = country.dial_code.replace('+', '').includes(normalizedText);
        return nameMatch || codeMatch || dialMatch;
      })
      .slice(0, limit);

    return res.json({
      success: true,
      data: filtered
    });
  } catch (error) {
    console.error('Country suggestions error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch country suggestions'
    });
  }
};

router.get('/city-suggestions', authenticateToken, createSuggestionHandler('city'));
router.get('/pincode-suggestions', authenticateToken, createSuggestionHandler('postcode'));
router.get('/country-suggestions', authenticateToken, createCountrySuggestionHandler);

module.exports = router;
