const videoInput = document.getElementById('videoInput');
const convertBtn = document.getElementById('convertBtn');
const logBox = document.getElementById('logBox');

function log(msg, type = 'info') {
  const div = document.createElement('div');
  div.textContent = `> ${msg}`;
  if (type === 'error') div.style.color = '#f87171';
  if (type === 'success') div.style.color = '#34d399';
  logBox.appendChild(div);
  logBox.scrollTop = logBox.scrollHeight;
}

convertBtn.addEventListener('click', async () => {
  const file = videoInput.files[0];
  if (!file) {
    alert('Please select an MP4 file first!');
    return;
  }

  convertBtn.disabled = true;
  log(`Uploading file "${file.name}" to the Native FFmpeg server...`);

  const formData = new FormData();
  formData.append('video', file);

  try {
    const response = await fetch('/transcode', {
      method: 'POST',
      body: formData
    });

    const data = await response.json();

    if (!response.ok || data.error) {
      throw new Error(data.error || 'Transcoding failure on the server');
    }

    log('Transcoding successful', 'success');
    log(`Stream URL: ${data.watchUrl}`, 'success');

    window.open(data.watchUrl, '_blank');

    convertBtn.disabled = false;

  } catch (err) {
    log(`Lỗi: ${err.message}`, 'error');
    convertBtn.disabled = false;
  }
});