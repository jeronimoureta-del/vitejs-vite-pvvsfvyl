const fetch = require('node-fetch');

exports.handler = async (event) => {
  const path = event.queryStringParameters?.path || 'fondo?limit=100&offset=0&estado=1';
  
  try {
    const res = await fetch(`https://api.cafci.org.ar/${path}`, {
      headers: { 'Accept': 'application/json' }
    });
    const data = await res.json();
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(data)
    };
  } catch (e) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: e.message })
    };
  }
};
