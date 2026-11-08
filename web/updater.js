'use strict';
/* GitHub Releases 更新检查：只读，不自动安装。桌面端与浏览器共用。 */
(() => {
  const REPO = 'NekoYume517/jiaojianbox';

  function compareVersions(a, b) {
    const pa = String(a).split(/[.\-]/).map(x => parseInt(x, 10) || 0);
    const pb = String(b).split(/[.\-]/).map(x => parseInt(x, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const diff = (pa[i] || 0) - (pb[i] || 0);
      if (diff) return diff;
    }
    return 0;
  }

  async function check(currentVersion) {
    const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(15000),
    });
    if (response.status === 404) return { updatable: false, current: currentVersion, reason: '尚无发布版本' };
    if (!response.ok) throw new Error(`检查更新失败（HTTP ${response.status}）`);
    const release = await response.json();
    const latest = String(release.tag_name || '').replace(/^v/, '');
    const asset = (release.assets || []).find(a => /win32-x64\.zip$/i.test(a.name));
    return {
      updatable: compareVersions(latest, currentVersion) > 0,
      current: currentVersion,
      latest,
      notes: release.body || '',
      url: release.html_url,
      download: asset ? asset.browser_download_url : release.html_url,
    };
  }

  window.updater = { check, compareVersions };
})();
