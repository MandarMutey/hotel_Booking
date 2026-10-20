const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const db = new Database(process.env.DB_FILE || path.join(__dirname, 'hotel.db'));
db.pragma('foreign_keys = ON');

// ---------- Schema ----------
db.exec(`
CREATE TABLE IF NOT EXISTS rooms (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  room_no TEXT NOT NULL UNIQUE,
  type    TEXT NOT NULL CHECK (type IN ('Single','Double','Suite')),
  price   REAL NOT NULL CHECK (price > 0)
);
CREATE TABLE IF NOT EXISTS bookings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id    INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  guest_name TEXT NOT NULL,
  check_in   TEXT NOT NULL,
  check_out  TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);`);

if (db.prepare('SELECT COUNT(*) c FROM rooms').get().c === 0) {
  const ins = db.prepare('INSERT INTO rooms (room_no,type,price) VALUES (?,?,?)');
  [['101','Single',2000],['102','Single',2200],['201','Double',3500],
   ['202','Double',3800],['301','Suite',7500]].forEach(r => ins.run(...r));
}

// ---------- Middleware ----------
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Helpers ----------
const today = () => new Date().toISOString().slice(0, 10);
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
const fail = (res, code, msg) => res.status(code).json({ error: msg });

// Two stays overlap if existing.check_in < new.check_out AND existing.check_out > new.check_in
// (check-out day is free for the next guest)
const OVERLAP = `check_in < @out AND check_out > @in`;

function validateStay(b) {
  if (!b.guest_name || !b.guest_name.trim()) return 'Guest name is required';
  if (!isDate(b.check_in) || !isDate(b.check_out)) return 'Valid check-in and check-out dates are required (YYYY-MM-DD)';
  if (b.check_in < today()) return 'Check-in date cannot be in the past';
  if (b.check_out <= b.check_in) return 'Check-out must be after check-in';
  return null;
}

// ---------- Rooms ----------
// List all rooms with today's availability status
app.get('/api/rooms', (req, res) => {
  const t = today();
  const rows = db.prepare(`
    SELECT r.*, EXISTS(SELECT 1 FROM bookings b WHERE b.room_id=r.id
            AND b.check_in <= @t AND b.check_out > @t) AS occupied
    FROM rooms r ORDER BY r.room_no`).all({ t });
  res.json(rows.map(r => ({ ...r, status: r.occupied ? 'Booked' : 'Available' })));
});

// Search available rooms by type and date range
app.get('/api/rooms/available', (req, res) => {
  const { type, check_in, check_out } = req.query;
  if (!isDate(check_in) || !isDate(check_out) || check_out <= check_in)
    return fail(res, 400, 'Provide valid check_in and check_out (check-out after check-in)');
  const rows = db.prepare(`
    SELECT * FROM rooms r
    WHERE (@type IS NULL OR @type = '' OR r.type = @type)
      AND NOT EXISTS (SELECT 1 FROM bookings WHERE room_id = r.id AND ${OVERLAP})
    ORDER BY r.price`).all({ type: type || null, in: check_in, out: check_out });
  res.json(rows);
});

app.post('/api/rooms', (req, res) => {
  const { room_no, type } = req.body;
  const price = Number(req.body.price);
  if (!room_no || !String(room_no).trim()) return fail(res, 400, 'Room number is required');
  if (!['Single', 'Double', 'Suite'].includes(type)) return fail(res, 400, 'Type must be Single, Double or Suite');
  if (!(price > 0)) return fail(res, 400, 'Price must be a positive number');
  try {
    const info = db.prepare('INSERT INTO rooms (room_no,type,price) VALUES (?,?,?)')
      .run(String(room_no).trim(), type, price);
    res.status(201).json({ id: info.lastInsertRowid, room_no: String(room_no).trim(), type, price });
  } catch (e) {
    if (String(e.code).startsWith('SQLITE_CONSTRAINT')) return fail(res, 409, `Room ${room_no} already exists`);
    throw e;
  }
});

app.delete('/api/rooms/:id', (req, res) => {
  const info = db.prepare('DELETE FROM rooms WHERE id = ?').run(req.params.id);
  if (!info.changes) return fail(res, 404, 'Room not found');
  res.json({ message: 'Room deleted' });
});

// ---------- Bookings ----------
app.get('/api/bookings', (req, res) => {
  res.json(db.prepare(`
    SELECT b.*, r.room_no, r.type, r.price,
           CAST(julianday(b.check_out) - julianday(b.check_in) AS INTEGER) AS nights
    FROM bookings b JOIN rooms r ON r.id = b.room_id
    ORDER BY b.check_in`).all());
});

app.post('/api/bookings', (req, res) => {
  const b = req.body;
  const err = validateStay(b);
  if (err) return fail(res, 400, err);
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(b.room_id);
  if (!room) return fail(res, 404, 'Room not found');

  // Transaction makes the check + insert atomic (no double-booking race)
  const book = db.transaction(() => {
    const clash = db.prepare(`SELECT 1 FROM bookings WHERE room_id=@id AND ${OVERLAP}`)
      .get({ id: room.id, in: b.check_in, out: b.check_out });
    if (clash) return null;
    return db.prepare('INSERT INTO bookings (room_id,guest_name,check_in,check_out) VALUES (?,?,?,?)')
      .run(room.id, b.guest_name.trim(), b.check_in, b.check_out).lastInsertRowid;
  });
  const id = book();
  if (!id) return fail(res, 409, `Room ${room.room_no} is already booked for overlapping dates`);
  res.status(201).json({ id, room_no: room.room_no, guest_name: b.guest_name.trim(), check_in: b.check_in, check_out: b.check_out });
});

// Modify dates / guest of an existing booking
app.put('/api/bookings/:id', (req, res) => {
  const cur = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
  if (!cur) return fail(res, 404, 'Booking not found');
  const b = { guest_name: cur.guest_name, check_in: cur.check_in, check_out: cur.check_out, ...req.body };
  const err = validateStay(b);
  if (err) return fail(res, 400, err);
  const clash = db.prepare(`SELECT 1 FROM bookings WHERE room_id=@rid AND id<>@id AND ${OVERLAP}`)
    .get({ rid: cur.room_id, id: cur.id, in: b.check_in, out: b.check_out });
  if (clash) return fail(res, 409, 'Room is already booked for those dates');
  db.prepare('UPDATE bookings SET guest_name=?, check_in=?, check_out=? WHERE id=?')
    .run(b.guest_name.trim(), b.check_in, b.check_out, cur.id);
  res.json({ message: 'Booking updated' });
});

app.delete('/api/bookings/:id', (req, res) => {
  const info = db.prepare('DELETE FROM bookings WHERE id = ?').run(req.params.id);
  if (!info.changes) return fail(res, 404, 'Booking not found');
  res.json({ message: 'Booking cancelled' });
});

// ---------- Error handling ----------
app.use('/api', (req, res) => fail(res, 404, 'Endpoint not found'));
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return fail(res, 400, 'Invalid JSON');
  console.error(err); fail(res, 500, 'Internal server error');
});

module.exports = app;
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Hotel booking app running at http://localhost:${PORT}`));
}
