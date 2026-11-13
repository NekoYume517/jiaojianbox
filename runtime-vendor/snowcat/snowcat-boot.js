/*
 * SnowCat 引导注入
 * 注入点：QQ 主进程 application.asar/app_launcher/index.js 的模块作用域
 * 手段：winmm 侧加载 + hook v8::ScriptCompiler::Compile，在源码编译前替换
 */
;(() => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');

  let logFile = path.join(os.tmpdir(), 'snowcat-boot.log');
  const log = (m) => {
    try {
      fs.appendFileSync(logFile, new Date().toISOString() + ' [pid ' + process.pid + '] ' + m + '\n');
    } catch (e) {}
  };

  try {
    // 模块路径形如 ...\resources\app\application.asar\app_launcher，
    // 需要逐级上溯才能到便携版根目录
    let dir = __dirname;
    let target = null;
    for (let i = 0; i < 8 && dir; i++) {
      const cand = path.join(dir, 'napcat.mjs');
      if (fs.existsSync(cand)) { target = cand; break; }
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }

    if (!target) { log('napcat.mjs not found from ' + __dirname); return; }

    logFile = path.join(path.dirname(target), 'nc-boot.log');
    log('injected; electron=' + (process.versions.electron || '?') + ' node=' + process.versions.node);
    log('napcat=' + target);

    import(require('url').pathToFileURL(target).href)
      .then(() => log('napcat imported ok'))
      .catch((e) => log('import failed: ' + ((e && e.stack) || e)));
  } catch (e) {
    log('outer error: ' + ((e && e.stack) || e));
  }
})();
