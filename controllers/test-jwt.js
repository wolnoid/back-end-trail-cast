
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');


// GENERATING AND SENDING TOKEN
router.get('/sign-token', (req, res) => {
  const user = {
    id: 1,
    username: 'test',
    password: 'test',
  };
  const token = jwt.sign({ user }, process.env.JWT_SECRET);

  // Send the token back to the client
  res.json({ token });
});

//VERIFY TOKEN
router.post('/verify-token', (req, res) => {
  try {
    const token = req.headers.authorization.split(' ')[1];
    // Add in verify method
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    res.json({ decoded });
  } catch (err) {
    res.status(401).json({ err: 'Invalid token.' });
  }
});




module.exports = router;
