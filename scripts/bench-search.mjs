async function timed(label, body) {
  const t0 = Date.now();
  const res = await fetch('http://localhost:3780/api/search/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const lines = text.trim().split(/\n+/).filter(Boolean);
  const progress = lines.filter((l) => l.includes('"progress"')).length;
  const last = JSON.parse(lines[lines.length - 1]);
  console.log(
    label,
    'ms=',
    Date.now() - t0,
    'progressEvents=',
    progress,
    'spus=',
    last.data?.meta?.matchedSpus,
    'type=',
    last.type,
  );
}

const q1 = { startDate: '20260707', endDate: '20260713', spuid: '', sku: '', categories: [], shop: '' };
const q2 = { startDate: '20260614', endDate: '20260713', spuid: '', sku: '', categories: [], shop: '' };

await timed('7d cold', q1);
await timed('7d warm', q1);
await timed('30d', q2);
await timed('30d warm', q2);
