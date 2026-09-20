const normalize = (s) =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
   .replace(/đ/gi, 'd').toLowerCase().replace(/[^a-z0-9]/g, '').trim();

// Chi loc nhom BLV bong da (Ga Vang, CoLa, Khan Dai, Bau Cua...)
// -> phai trung voi BANNED_GROUPS trong server.js.
// Nhom kenh nuoc ngoai (Han Quoc, Trung Quoc, Thai Lan) GIU NGUYEN.
const BANNED = ['gavang', 'colatvm', 'colatv', 'khandai', 'baucua'];

const isBanned = (name) => {
  const n = normalize(name);
  return BANNED.some((b) => n.includes(b));
};
const groups = [
  // Nhom BLV bong da -> phai FILTERED
  'Gà Vàng', 'CoLa TVM', 'Cò Lả TVM', 'Khán Đài A', 'Khán dãi', 'Bầu Cua',
  'Ga Vang TV', 'Gà Vang', '🔴 ⚽ COLA TV', '🔴 ⚽ 🏀 COLA TV SV2',
  '🔴 ⚽ 🏀 COLA TV SV3', '🔴 ⚽ GÀ VÀNG 33', '🔴 ⚽ GÀ VÀNG 33 SV2',
  '🔴 ⚽ 🏐 KHÁN ĐÀI TV',
  // Nhom giu lai -> phai kept
  '🇰🇷| Hàn Quốc', '🇨🇳| Trung Quốc', '🇹🇭| Thái Lan',
  '🇬🇧 UK Radio', 'Israel', 'Radio', 'Quốc Tế', 'VTV', 'SCTV', 'Thể Thao'
];
for (const g of groups) console.log(g.padEnd(28), '->', isBanned(g) ? 'FILTERED' : 'kept');

