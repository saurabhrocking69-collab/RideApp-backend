function maskPhone(phone) {
  if (!phone) return null;
  const s = String(phone);
  if (s.length < 6) return '***';
  return s.substring(0, 2) + '*'.repeat(s.length - 4) + s.substring(s.length - 2);
}

module.exports = { maskPhone };
