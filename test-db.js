
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

console.log('Starting DB test...');

try {
  const dbPath = path.join(__dirname, 'test.db');
  console.log(`DB Path: ${dbPath}`);

  if (fs.existsSync(dbPath)) {
    fs.unlinkSync(dbPath);
  }

  const db = new Database(dbPath);
  console.log('DB created');

  db.exec('CREATE TABLE IF NOT EXISTS test (id INTEGER PRIMARY KEY, value TEXT)');
  console.log('Table created');

  const stmt = db.prepare('INSERT INTO test (value) VALUES (?)');
  stmt.run('hello');
  console.log('Data inserted');

  const row = db.prepare('SELECT * FROM test').get();
  console.log('Data retrieved:', row);

  db.close();
  console.log('DB closed');

} catch (error) {
  console.error('DB Error:', error);
}

console.log('Finished DB test');
