const config = await fetch('/api/config').then((r) => r.json());
document.querySelector('#business-name').textContent = config.businessName;
if (config.requiresEmail) { document.querySelector('#email').required = true; document.querySelector('#email-optional').textContent = ''; }

const mediaFiles = [];
const mediaFileInput = document.querySelector('#media-file');
const mediaPreview = document.querySelector('#media-preview');

mediaFileInput.addEventListener('change', (event) => {
  for (const file of event.target.files) {
    mediaFiles.push(file);
    const img = document.createElement('img');
    img.src = URL.createObjectURL(file);
    img.height = 100;
    img.onload = () => URL.revokeObjectURL(img.src);
    mediaPreview.appendChild(img);
  }
});

document.querySelector('#intake-form').addEventListener('submit', async (event) => { event.preventDefault(); const form = event.currentTarget; const data = Object.fromEntries(new FormData(form)); const response = await fetch('/api/requests', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }); const payload = await response.json(); const errors = document.querySelector('#errors'); if (!response.ok) { errors.textContent = Object.values(payload.errors ?? { error: 'Please try again.' }).join('. '); return; } sessionStorage.setItem(`request-token:${payload.requestId}`, payload.accessToken); form.closest('#form-panel').classList.add('hidden'); document.querySelector('#success').classList.remove('hidden'); });
