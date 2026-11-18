function messageSender(message) {
  if (message.direction === 'self' || message.is_self === true) return '我';
  return message.sender_name || (message.direction === 'system' ? '系统' : '未知发送者');
}

function messageMediaMarkup(message, detail = false) {
  const media = message.media;
  if (!media && !message.metadata?.media_status) return '';
  const stateLabel = { ready: '图片', not_downloaded: '图片未下载到本机', decrypt_failed: '图片暂无法读取' }[media?.status || message.metadata?.media_status] || '图片';
  if (media?.status === 'ready' && media.id) {
    return `<div class="message-media ${detail ? 'detail' : ''}"><img data-message-image="${esc(message.id)}" data-media-id="${esc(media.id)}" alt="${esc(message.conversation_name || '微信')}的图片" loading="lazy" hidden><span class="helper" data-message-image-loading>正在读取图片…</span></div>`;
  }
  return `<div class="message-media missing">${icon('image')}<span>${esc(stateLabel)}。本机未保存可读取的图片。</span></div>`;
}

async function loadMessageImages(root = document) {
  const errors = [];
  for (const image of root.querySelectorAll('img[data-message-image]')) {
    if (image.dataset.loading) continue;
    image.dataset.loading = 'true';
    try {
      const response = await fetch(apiUrl('/api/messages/' + encodeURIComponent(image.dataset.messageImage) + '/media/' + encodeURIComponent(image.dataset.mediaId)), { headers: { Authorization: 'Bearer ' + state.session.token } });
      if (!response.ok) throw new Error('图片读取失败');
      image.src = URL.createObjectURL(await response.blob());
      image.hidden = false;
      image.nextElementSibling?.remove();
    } catch {
      const note = image.nextElementSibling;
      if (note) note.textContent = '图片暂不可读取，请稍后刷新重试';
    }
  }
}
