import express from 'express';
import fs from 'fs';
import path from 'path';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

const DATA_PATH = path.join(__dirname, 'data.json');
let assignments = {};

if (fs.existsSync(DATA_PATH)) {
  assignments = JSON.parse(fs.readFileSync(DATA_PATH));
}

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.get('/assignments', (req, res) => {
  res.json(assignments);
});

app.post('/assignments', (req, res) => {
  const { day, name } = req.body;

  if (typeof day !== 'string' || typeof name !== 'string') {
    return res.status(400).json({ error: 'Ugyldige data' });
  }

  assignments[day] = name;
  fs.writeFileSync(DATA_PATH, JSON.stringify(assignments, null, 2));
  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`✅ Server kører på http://localhost:${PORT}`);
});
