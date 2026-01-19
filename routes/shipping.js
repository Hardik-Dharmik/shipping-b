const express = require('express');
const router = express.Router();
const { authenticateToken } = require('./auth');

// Calculate shipping quote endpoint
router.post('/quote', authenticateToken, async (req, res) => {
  try {
    const {
      pickupCountry,
      pickupPincode,
      destinationCountry,
      destinationPincode,
      actualWeight,
      length,
      breadth,
      height,
      shipmentValue
    } = req.body;

    // Validate required fields
    if (!pickupCountry || !pickupPincode || !destinationCountry || !destinationPincode || !actualWeight) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: pickupCountry, pickupPincode, destinationCountry, destinationPincode, actualWeight'
      });
    }

    // Validate weight is a positive number
    const weight = parseFloat(actualWeight);
    if (isNaN(weight) || weight <= 0) {
      return res.status(400).json({
        success: false,
        error: 'actualWeight must be a positive number'
      });
    }

    // Optional: Validate dimensions if provided
    const dimensions = {};
    if (length) {
      const len = parseFloat(length);
      if (!isNaN(len) && len > 0) dimensions.length = len;
    }
    if (breadth) {
      const br = parseFloat(breadth);
      if (!isNaN(br) && br > 0) dimensions.breadth = br;
    }
    if (height) {
      const ht = parseFloat(height);
      if (!isNaN(ht) && ht > 0) dimensions.height = ht;
    }

    // Optional: Validate shipment value if provided
    let shipmentValueNum = null;
    if (shipmentValue) {
      shipmentValueNum = parseFloat(shipmentValue);
      if (isNaN(shipmentValueNum) || shipmentValueNum < 0) {
        return res.status(400).json({
          success: false,
          error: 'shipmentValue must be a non-negative number'
        });
      }
    }

    // Calculate shipping costs based on weight (cost = weight * rate)
    // DHL: 10 dirham per kg
    // FedEx: 8 dirham per kg
    // UPS: 6 dirham per kg
    const dhlRate = 10;
    const fedexRate = 8;
    const upsRate = 6;
    
    const dhlCost = weight * dhlRate;
    const fedexCost = weight * fedexRate;
    const upsCost = weight * upsRate;

    // Generate random estimated delivery times (in days)
    // Random between 3-7 days for international shipping
    const getRandomDeliveryDays = (min, max) => {
      return Math.floor(Math.random() * (max - min + 1)) + min;
    };
    
    // Function to calculate estimated delivery date and time
    const calculateDeliveryDateTime = (deliveryDays) => {
      const now = new Date();
      let deliveryDate = new Date(now);
      
      // Add business days (skip weekends)
      let daysAdded = 0;
      while (daysAdded < deliveryDays) {
        deliveryDate.setDate(deliveryDate.getDate() + 1);
        // Skip weekends (Saturday = 6, Sunday = 0)
        if (deliveryDate.getDay() !== 0 && deliveryDate.getDay() !== 6) {
          daysAdded++;
        }
      }
      
      // Generate random time between 9 AM and 6 PM (business hours)
      const randomHour = Math.floor(Math.random() * 9) + 9; // 9-17 (9 AM to 5 PM)
      const randomMinute = Math.floor(Math.random() * 60); // 0-59
      
      deliveryDate.setHours(randomHour, randomMinute, 0, 0);
      
      // Format date and time
      const dateStr = deliveryDate.toISOString().split('T')[0];
      const timeStr = deliveryDate.toTimeString().split(' ')[0];
      const dateTimeISO = deliveryDate.toISOString();
      
      // Format readable date and time
      const options = { 
        year: 'numeric', 
        month: 'long', 
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
      };
      const readableDateTime = deliveryDate.toLocaleString('en-US', options);
      
      return {
        date: dateStr,
        time: timeStr,
        dateTime: dateTimeISO,
        readable: readableDateTime
      };
    };
    
    const dhlDeliveryDays = getRandomDeliveryDays(3, 7);
    const fedexDeliveryDays = getRandomDeliveryDays(3, 7);
    const upsDeliveryDays = getRandomDeliveryDays(3, 7);
    
    const dhlDeliveryDateTime = calculateDeliveryDateTime(dhlDeliveryDays);
    const fedexDeliveryDateTime = calculateDeliveryDateTime(fedexDeliveryDays);
    const upsDeliveryDateTime = calculateDeliveryDateTime(upsDeliveryDays);

    // Prepare response with calculated data
    const quoteData = {
      pickup: {
        country: pickupCountry,
        pincode: pickupPincode
      },
      destination: {
        country: destinationCountry,
        pincode: destinationPincode
      },
      weight: {
        actualWeight: weight,
        unit: 'kg'
      },
      dimensions: Object.keys(dimensions).length > 0 ? {
        ...dimensions,
        unit: 'cm'
      } : null,
      shipmentValue: shipmentValueNum ? {
        value: shipmentValueNum,
        currency: 'AED'
      } : null,
      quotes: [
        {
          carrier: 'DHL',
          cost: dhlCost,
          currency: 'AED',
          estimatedDeliveryDays: dhlDeliveryDays,
          estimatedDelivery: `${dhlDeliveryDays} business days`,
          estimatedDeliveryDate: dhlDeliveryDateTime.date,
          estimatedDeliveryTime: dhlDeliveryDateTime.time,
          estimatedDeliveryDateTime: dhlDeliveryDateTime.dateTime,
          estimatedDeliveryReadable: dhlDeliveryDateTime.readable
        },
        {
          carrier: 'FedEx',
          cost: fedexCost,
          currency: 'AED',
          estimatedDeliveryDays: fedexDeliveryDays,
          estimatedDelivery: `${fedexDeliveryDays} business days`,
          estimatedDeliveryDate: fedexDeliveryDateTime.date,
          estimatedDeliveryTime: fedexDeliveryDateTime.time,
          estimatedDeliveryDateTime: fedexDeliveryDateTime.dateTime,
          estimatedDeliveryReadable: fedexDeliveryDateTime.readable
        },
        {
          carrier: 'UPS',
          cost: upsCost,
          currency: 'AED',
          estimatedDeliveryDays: upsDeliveryDays,
          estimatedDelivery: `${upsDeliveryDays} business days`,
          estimatedDeliveryDate: upsDeliveryDateTime.date,
          estimatedDeliveryTime: upsDeliveryDateTime.time,
          estimatedDeliveryDateTime: upsDeliveryDateTime.dateTime,
          estimatedDeliveryReadable: upsDeliveryDateTime.readable
        }
      ],
      calculatedAt: new Date().toISOString()
    };

    res.json({
      success: true,
      data: quoteData
    });

  } catch (error) {
    console.error('Shipping quote error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

module.exports = router;

