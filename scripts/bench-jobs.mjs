const body = {
  startDate: '20260701',
  endDate: '20260713',
  spuid: '',
  sku: '',
  categories: [],
  shop: '',
};

const t0 = Date.now();
const created = await fetch('http://localhost:3780/api/jobs', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}).then((r) => r.json());

console.log('created', created, 'ms', Date.now() - t0);
const id = created.id;

while (true) {
  await new Promise((r) => setTimeout(r, 200));
  const job = await fetch(`http://localhost:3780/api/jobs/${id}`).then((r) => r.json());
  const p = job.data.progress;
  console.log(Date.now() - t0, 'ms', job.data.status, p?.done, '/', p?.total, p?.label);
  if (job.data.status === 'done') {
    console.log('spus', job.data.result.meta.matchedSpus);
    break;
  }
  if (job.data.status === 'error') {
    console.log('error', job.data.error);
    break;
  }
}
