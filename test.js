// Edge-case tests: run with `npm test` (uses a throw-away database)
process.env.DB_FILE = ':memory:';
const app = require('./server');
const assert = require('assert');
const server = app.listen(0, async () => {
  const base = `http://localhost:${server.address().port}/api`;
  const call = async (m, p, body) => {
    const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    return { status: r.status, data: await r.json() };
  };
  const d = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  let pass = 0;
  const t = (name, ok) => { assert(ok, name); console.log('  ✓ ' + name); pass++; };
  try {
    const rooms = (await call('GET', '/rooms')).data;
    t('seed rooms listed', rooms.length === 5);
    t('duplicate room rejected (409)', (await call('POST', '/rooms', { room_no: '101', type: 'Single', price: 1 })).status === 409);
    t('negative price rejected (400)', (await call('POST', '/rooms', { room_no: '999', type: 'Single', price: -5 })).status === 400);
    const rid = rooms[0].id;
    const b1 = await call('POST', '/bookings', { room_id: rid, guest_name: 'Asha', check_in: d(2), check_out: d(5) });
    t('booking created (201)', b1.status === 201);
    t('overlapping booking blocked (409)', (await call('POST', '/bookings', { room_id: rid, guest_name: 'Ravi', check_in: d(4), check_out: d(7) })).status === 409);
    t('back-to-back booking allowed', (await call('POST', '/bookings', { room_id: rid, guest_name: 'Ravi', check_in: d(5), check_out: d(7) })).status === 201);
    t('check-out before check-in rejected', (await call('POST', '/bookings', { room_id: rid, guest_name: 'X', check_in: d(5), check_out: d(3) })).status === 400);
    t('past check-in rejected', (await call('POST', '/bookings', { room_id: rid, guest_name: 'X', check_in: d(-3), check_out: d(1) })).status === 400);
    t('blank guest rejected', (await call('POST', '/bookings', { room_id: rid, guest_name: ' ', check_in: d(9), check_out: d(10) })).status === 400);
    t('unknown room -> 404', (await call('POST', '/bookings', { room_id: 999, guest_name: 'X', check_in: d(9), check_out: d(10) })).status === 404);
    const av = (await call('GET', `/rooms/available?type=Single&check_in=${d(3)}&check_out=${d(4)}`)).data;
    t('search excludes booked room', av.length === 1 && av[0].id !== rid);
    t('cancel booking works', (await call('DELETE', `/bookings/${b1.data.id}`)).status === 200);
    t('cancel non-existent booking -> 404', (await call('DELETE', '/bookings/9999')).status === 404);
    console.log(`\nAll ${pass} tests passed`);
  } catch (e) { console.error('✗ FAILED:', e.message); process.exitCode = 1; }
  server.close();
});
