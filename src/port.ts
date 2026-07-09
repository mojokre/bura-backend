/** Railway injects PORT at runtime — always trust it over any default. */
export function readPort(): number {
  const raw = process.env.PORT;
  if (raw != null && raw !== "") {
    const n = Number(String(raw).trim());
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 4000;
}
