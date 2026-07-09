const http = require('http');

console.log('Triggering snapshot via HTTP POST...');

const options = {
    hostname: '127.0.0.1',
    port: 3000,
    path: '/api/metrics/snapshot-all?date=2026-02-06',
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Content-Length': 0
    }
};

const req = http.request(options, (res) => {
    console.log(`STATUS: ${res.statusCode}`);
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
        console.log(`BODY: ${chunk}`);
    });
    res.on('end', () => {
        console.log('Response finished.');
    });
});

req.on('error', (e) => {
    console.error(`Request error: ${e.message}`);
});

req.end();
