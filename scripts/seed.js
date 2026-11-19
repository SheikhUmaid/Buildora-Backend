/**
 * Seeds demo data. WARNING: wipes the Buildora collections in the configured database.
 *   npm run seed
 *
 * Logins created:
 *   Engineer app : rakesh@nairbuilds.in / password123
 *   Client app   : abhinav@example.com  / password123
 *   Laborer      : 8646965663 / PIN 1234   and   8646965664 / PIN 4569
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { connectDb } from '../src/db.js';
import { config } from '../src/config.js';
import { User, Laborer, Project, Update, Request, Notification } from '../src/models/index.js';
import { refreshProjectStats } from '../src/services/projects.js';

const uploadDir = fileURLToPath(config.uploadDir);

// ---------- Tiny PNG writer for placeholder "site photos" ----------
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** Draws a sky / building / ground scene with a few "columns" so photos look distinct. */
function scenePng(seed, w = 800, h = 600) {
  const rnd = (() => {
    let s = seed * 9301 + 49297;
    return () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  })();
  const sky = [150 + rnd() * 60, 180 + rnd() * 40, 210 + rnd() * 40];
  const wall = [150 + rnd() * 80, 90 + rnd() * 50, 60 + rnd() * 40];
  const ground = [120 + rnd() * 40, 110 + rnd() * 30, 95 + rnd() * 30];
  const cols = Array.from({ length: 4 + Math.floor(rnd() * 4) }, () => Math.floor(rnd() * w));
  const top = Math.floor(h * (0.25 + rnd() * 0.15));
  const horizon = Math.floor(h * 0.72);
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < w; x++) {
      let c;
      const isCol = cols.some((cx) => Math.abs(x - cx) < 10) && y > top - 60 && y < horizon;
      if (isCol) c = [90, 90, 95];
      else if (y < top) c = sky.map((v) => v - (y / top) * 30);
      else if (y < horizon) c = (Math.floor(y / 18) + Math.floor(x / 40)) % 2 ? wall : wall.map((v) => v - 15);
      else c = ground.map((v) => v - ((y - horizon) / (h - horizon)) * 25);
      const i = row + 1 + x * 3;
      raw[i] = c[0];
      raw[i + 1] = c[1];
      raw[i + 2] = c[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
let photoSeed = 1;
const assetDir = fileURLToPath(new URL('../seed-assets/', import.meta.url));

/**
 * Copy a demo photo from seed-assets/ into uploads/. Falls back to a generated
 * placeholder if the file is missing, so the seed always works.
 */
function photo(name) {
  fs.mkdirSync(uploadDir, { recursive: true });
  const n = photoSeed++;
  const src = name && path.join(assetDir, `${name}.jpg`);
  if (src && fs.existsSync(src)) {
    const file = `seed-${n}-${name}.jpg`;
    fs.copyFileSync(src, path.join(uploadDir, file));
    return `/uploads/${file}`;
  }
  const file = `seed-${n}.png`;
  fs.writeFileSync(path.join(uploadDir, file), scenePng(n));
  return `/uploads/${file}`;
}
const photos = (...names) => names.map(photo);

const daysAgo = (n) => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return d;
};

async function main() {
  await connectDb();
  await Promise.all([User, Laborer, Project, Update, Request, Notification].map((m) => m.deleteMany({})));
  fs.mkdirSync(uploadDir, { recursive: true });
  for (const f of fs.readdirSync(uploadDir)) if (f.startsWith('seed-')) fs.unlinkSync(path.join(uploadDir, f));

  const rakesh = new User({
    name: 'Rakesh Nair',
    email: 'rakesh@nairbuilds.in',
    phone: '+91 98450 12345',
    role: 'engineer',
    profession: 'Engineer',
    title: 'Civil Engineer',
    company: 'Nair Builds',
    bio: '14 years building homes across Bengaluru. Focused on structural quality and clear daily reporting.',
    location: 'Bengaluru',
    yearsExperience: 14,
  });
  await rakesh.setPassword('password123');
  await rakesh.save();

  const abhinav = new User({ name: 'Abhinav Gupta', email: 'abhinav@example.com', phone: '+91 8965899989', role: 'client' });
  await abhinav.setPassword('password123');
  await abhinav.save();

  const raju = new User({ name: 'Raju Sharma', email: 'raju@example.com', phone: '+91 9000000001', role: 'client' });
  await raju.setPassword('password123');
  await raju.save();

  const skyline = await Project.create({
    engineer: rakesh._id, clients: [abhinav._id], name: 'Skyline Villa', location: 'Whitefield, Bengaluru',
    address: 'Plot 42, ITPL Main Rd, Whitefield, Bengaluru', status: 'in_progress', progress: 62,
    startDate: new Date('2026-03-12'), expectedFinish: new Date('2027-02-28'), budget: 12_000_000,
    budgetVisible: true, inviteCode: 'SKY123', coverImage: photo('design_house_frame'),
  });
  const lakeview = await Project.create({
    engineer: rakesh._id, clients: [abhinav._id], name: 'Lakeview Duplex', location: 'Hebbal, Bengaluru',
    status: 'completed', progress: 100, startDate: new Date('2025-01-10'), completedAt: new Date('2025-11-20'),
    budget: 8_500_000, inviteCode: 'LAKE42', coverImage: photo('design_white_villa_b'),
    portfolio: { story: 'A compact duplex overlooking Hebbal lake, built around a central light well.', highlights: [] },
  });
  const green = await Project.create({
    engineer: rakesh._id, clients: [abhinav._id], name: 'Green Court Annex', location: 'HSR Layout, Bengaluru',
    status: 'in_progress', progress: 35, startDate: new Date('2026-07-01'), expectedFinish: new Date('2027-06-30'),
    budget: 6_000_000, budgetVisible: false, inviteCode: 'GREEN7', coverImage: photo('commons_scaffolding_2'),
  });
  const palm = await Project.create({
    engineer: rakesh._id, clients: [raju._id], name: 'Palm Court Row Houses', location: 'Sarjapur, Bengaluru',
    status: 'completed', progress: 100, startDate: new Date('2023-01-30'), completedAt: new Date('2023-09-30'),
    budget: 30_000_000, inviteCode: 'PALM99', coverImage: photo('design_white_villa'),
    portfolio: {
      featured: true,
      story: 'Challenge: Six homes on a sloped plot. What we built: Stepped foundations and shared courtyards. Result: Handed over two weeks early.',
    },
    feedback: [{ client: raju._id, authorName: 'Raju', rating: 4, text: 'Daily photos meant I never had to visit site to know where we stood.' }],
  });
  palm.portfolio.highlights = photos('design_white_villa', 'design_house_frame', 'design_column_shuttering', 'commons_slab_3');
  lakeview.portfolio.highlights = photos('design_white_villa_b', 'commons_villa_construction_3');
  await lakeview.save();
  await palm.save();

  const manoj = await Laborer.create({ engineer: rakesh._id, name: 'Manoj Kumar', phone: '8646965663', pin: '1234', trade: 'Electrician', projects: [skyline._id] });
  await Laborer.create({ engineer: rakesh._id, name: 'Suresh Rao', phone: '8646965664', pin: '4569', trade: 'Carpenter', projects: [skyline._id, green._id] });

  const eng = { kind: 'engineer', id: rakesh._id, name: rakesh.name };
  const skylineUpdates = [
    { d: 1, note: 'Column shuttering completed for ground floor. Rebar inspection done. Concrete pour planned for tomorrow morning.', work: ['Shuttering', 'Rebar'], labs: [{ trade: 'Mason', count: 10 }, { trade: 'Carpenter', count: 6 }, { trade: 'Helper', count: 2 }], pics: ['design_column_shuttering', 'commons_column_formwork_1', 'commons_rebar_1', 'design_house_frame'], p: 62 },
    { d: 2, note: 'Rebar cages tied for remaining eight columns. Cover blocks placed.', work: ['Rebar'], labs: [{ trade: 'Helper', count: 10 }, { trade: 'Mason', count: 6 }], pics: ['commons_rebar_1', 'commons_slab_0', 'commons_column_formwork_5'], p: 60 },
    { d: 4, note: 'Brickwork on east wall reached lintel level.', work: ['Brickwork'], labs: [{ trade: 'Mason', count: 8 }, { trade: 'Helper', count: 4 }], pics: ['commons_villa_construction_3', 'commons_villa_construction_2'], p: 58 },
    { d: 9, note: 'Electrical conduits laid in first floor slab before pour.', work: ['Electrical'], labs: [{ trade: 'Electrician', count: 3 }], pics: ['commons_slab_4', 'commons_slab_0'], p: 55 },
    { d: 35, note: 'First floor slab poured and curing started.', work: ['Concrete pour'], labs: [{ trade: 'Mason', count: 14 }, { trade: 'Helper', count: 12 }], pics: ['commons_slab_3', 'commons_slab_5'], p: 48 },
  ];
  const created = [];
  for (const u of skylineUpdates) {
    created.push(
      await Update.create({
        project: skyline._id, author: eng, date: daysAgo(u.d), note: u.note, workTypes: u.work, laborers: u.labs,
        totalLaborers: u.labs.reduce((s, l) => s + l.count, 0), progress: u.p,
        photos: photos(...u.pics),
      }),
    );
  }
  await Update.create({
    project: skyline._id, author: { kind: 'laborer', id: manoj._id, name: manoj.name, trade: manoj.trade },
    date: daysAgo(3), note: 'Masonry work completed on the east wall.', workTypes: ['Brickwork'],
    laborers: [{ trade: 'Mason', count: 6 }], totalLaborers: 6, progress: 59, photos: photos('commons_villa_construction_4'),
  });
  await Update.create({
    project: green._id, author: eng, date: daysAgo(2), note: 'Footing formwork fixed and checked. Concrete for footings tomorrow morning.',
    workTypes: ['Shuttering'], laborers: [{ trade: 'Helper', count: 9 }], totalLaborers: 9, progress: 35, photos: photos('commons_column_formwork_3', 'commons_slab_2'),
  });
  for (let i = 0; i < 6; i++) {
    await Update.create({
      project: palm._id, author: eng, date: new Date(2023, 2 + i, 10), note: [
        'Stepped foundations complete for all six homes.',
        'Ground floor slab poured across blocks A and B.',
        'Brickwork up to lintel level on every unit.',
        'Roof slab shuttering and reinforcement checked.',
        'Plastering and electrical first fix done.',
        'Final paint and landscaping. Ready for handover.',
      ][i],
      workTypes: ['Finishing'], laborers: [{ trade: 'Mason', count: 18 + i * 2 }], totalLaborers: 18 + i * 2, progress: 15 * (i + 1),
      photos: photos(['commons_slab_2', 'commons_slab_3', 'commons_villa_construction_2', 'commons_column_formwork_5', 'design_house_frame', 'design_white_villa'][i]),
    });
  }

  const latest = created[0];
  latest.approvedBy = [abhinav._id];
  await latest.save();
  await Request.create([
    { project: skyline._id, engineer: rakesh._id, client: abhinav._id, update: latest._id, type: 'approval', message: 'Looks good. Approved this update.', status: 'done', resolvedAt: new Date() },
    { project: skyline._id, engineer: rakesh._id, client: abhinav._id, update: latest._id, type: 'question', message: 'Will the pour need extra curing time if it rains tomorrow?', status: 'new', seenAt: new Date() },
    {
      project: skyline._id, engineer: rakesh._id, client: abhinav._id, update: latest._id, type: 'change', urgent: true,
      message: 'Please use the thicker rebar spacing as discussed.', status: 'in_progress', seenAt: new Date(),
      replies: [{ authorId: rakesh._id, authorName: rakesh.name, authorRole: 'engineer', message: 'Noted. We are re-spacing the remaining columns before the pour.' }],
    },
  ]);

  for (const p of [skyline, lakeview, green, palm]) await refreshProjectStats(p._id);
  console.log('Seed complete.');
  console.log('  Engineer : rakesh@nairbuilds.in / password123');
  console.log('  Client   : abhinav@example.com / password123   (invite codes: SKY123, LAKE42, GREEN7)');
  console.log('  Laborers : 8646965663 / 1234,  8646965664 / 4569');
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect();
  process.exit(1);
});
