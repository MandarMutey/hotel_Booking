# Hotel Room Booking System

Full-stack mini project: **HTML/CSS/JS** frontend · **Node.js + Express** backend · **SQLite** database.

## Run
```bash
npm install
npm start          # http://localhost:3000
npm test           # 13 edge-case tests
```
Requires Node.js 18+. The database file `hotel.db` is created automatically with 5 sample rooms.

## REST API
| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/rooms` | List rooms (+ today's status) |
| POST | `/api/rooms` | Add a room `{room_no,type,price}` |
| DELETE | `/api/rooms/:id` | Delete a room |
| GET | `/api/rooms/available?type=&check_in=&check_out=` | Search free rooms |
| GET | `/api/bookings` | List bookings |
| POST | `/api/bookings` | Book `{room_id,guest_name,check_in,check_out}` |
| PUT | `/api/bookings/:id` | Change dates / guest |
| DELETE | `/api/bookings/:id` | Cancel booking |

## Schema
- `rooms(id PK, room_no UNIQUE, type, price)`
- `bookings(id PK, room_id FK→rooms ON DELETE CASCADE, guest_name, check_in, check_out, created_at)`

## Double-booking rule
Two stays clash when `existing.check_in < new.check_out AND existing.check_out > new.check_in`.
Check-out day is free for the next guest. The check and insert run inside one SQLite transaction.
