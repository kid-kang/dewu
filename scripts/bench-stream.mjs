const body = {
  startDate: '20260101',
  endDate: '20260713',
  spuid: '',
  sku: '',
  categories: [],
  shop: '',
};

const t0 = Date.now();
const res = await fetch('http://localhost:3780/api/search/stream', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

console.log('headers ms=', Date.now() - t0, 'status=', res.status);

const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = '';
let progressCount = 0;

while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split('\n');
  buffer = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    const evt = JSON.parse(line);
    if (evt.type === 'progress') {
      progressCount += 1;
      if (progressCount <= 3 || progressCount % 50 === 0) {
        console.log('progress', progressCount, 'at', Date.now() - t0, 'ms', evt.done, '/', evt.total, evt.label);
      }
    } else if (evt.type === 'result') {
      console.log('result at', Date.now() - t0, 'ms spus=', evt.data.meta.matchedSpus, 'progressEvents=', progressCount);
    } else {
      console.log(evt);
    }
  }
}
