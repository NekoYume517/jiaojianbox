'use strict';
(()=>{
 let charts=[],observer,epoch=0,days=30,lastData,loaded,credit=null,mode='custom',unit='credits';
 const num=n=>Number(n||0).toLocaleString('zh-CN');
 const seconds=n=>n==null?'—':(n/1000).toFixed(1)+' 秒';
 const statusName={success:'成功',http_error:'接口错误',timeout:'超时',cancelled:'已取消',invalid_output:'格式无效',connection_error:'连接失败'};
 function page(){return heading('使用统计','查看模型消耗与响应表现。统计按北京时间汇总。','<button class="secondary" data-statistics-refresh>刷新统计</button>')+'<div class="statistics-controls"><label>统计范围<select id="statistics-days"><option value="7">最近 7 天</option><option value="30">最近 30 天</option><option value="90">最近 90 天</option></select></label><div class="chart-mode" id="chart-mode" hidden role="tablist" aria-label="统计来源"><button type="button" role="tab" data-chart-mode="managed">默认</button><button type="button" role="tab" data-chart-mode="custom">自定义</button></div><span id="statistics-state" class="helper" role="status">正在读取统计…</span></div><div id="statistics-credit" class="managed-overview" hidden></div><div id="statistics-summary" class="statistics-summary"></div><div class="statistics-grid"><section class="panel statistics-wide"><div class="panel-head"><h3 id="tokens-title">每日 Token 消耗</h3><small id="tokens-note">接口实际返回的 usage</small><div class="chart-mode" id="statistics-unit" hidden role="tablist" aria-label="消耗单位"><button type="button" role="tab" data-stat-unit="credits">积分</button><button type="button" role="tab" data-stat-unit="tokens">Token</button></div></div><div id="chart-tokens" class="statistics-chart" aria-label="每日输入和输出 Token 消耗图"></div></section><section class="panel"><div class="panel-head"><h3>响应耗时</h3><small>成功请求 · 秒</small></div><div id="chart-latency" class="statistics-chart" aria-label="每日平均、P95和首字耗时图"></div></section><section class="panel"><div class="panel-head"><h3>每日响应情况</h3><small>通知分析与文件整理</small></div><div id="chart-status" class="statistics-chart" aria-label="每日成功与失败调用次数图"></div></section></div><p class="helper">统计从升级后开始记录。接口未上报 usage 的调用单独计数；不按字数估算 Token，也不包含在已知消耗里。</p><div id="statistics-models"></div><section class="panel"><div class="panel-head"><h3>最近调用</h3><small>最多显示 30 次，不记录聊天正文与 API Key</small></div><div id="statistics-recent" class="statistics-table"></div></section>';}
 const managedOn=()=>!!(credit&&credit.enabled);
 let modeChosen=false;
 function syncMode(){const tabs=$('#chart-mode');if(!tabs)return;tabs.hidden=!managedOn();if(managedOn()&&!modeChosen)mode='managed';if(!managedOn()){mode='custom';modeChosen=false;}$$('[data-chart-mode]').forEach(b=>{const on=b.dataset.chartMode===mode;b.classList.toggle('active',on);b.setAttribute('aria-selected',String(on));b.tabIndex=on?0:-1;});uiMotion.syncSegments();}
 const creditText=value=>(Math.round(Number(value||0)*1000)/1000).toLocaleString('zh-CN');
 const metric=(label,value,note)=>'<section data-motion-key="metric-'+label+'" class="panel stat-metric"><span>'+label+'</span><strong>'+value+'</strong><small>'+note+'</small></section>';
 function dispose(){observer?.disconnect();observer=null;for(const c of charts)c.dispose();charts=[];}
 function library(){if(window.echarts)return Promise.resolve();if(!loaded)loaded=new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='./vendor/echarts.min.js';script.onload=resolve;script.onerror=()=>{loaded=null;reject(Error('统计图表组件加载失败'));};document.head.append(script);});return loaded;}
 function draw(data){if(state.page!=='stats'||!$('#chart-tokens'))return;dispose();lastData=data;
  const styles=getComputedStyle(document.documentElement),ink=styles.getPropertyValue('--text').trim(),muted=styles.getPropertyValue('--muted').trim(),line=styles.getPropertyValue('--line').trim(),green=styles.getPropertyValue('--green').trim();const dark=document.documentElement.dataset.theme==='dark';
  const dates=data.daily.map(d=>d.date.slice(5));const common={backgroundColor:'transparent',animation:false,aria:{enabled:true},color:[green,styles.getPropertyValue('--chart-blue').trim(),styles.getPropertyValue('--chart-amber').trim()],textStyle:{fontFamily:'Segoe UI,Microsoft YaHei UI,sans-serif',color:ink},tooltip:{trigger:'axis',renderMode:'richText',confine:true},legend:{top:10,textStyle:{color:muted,fontSize:11}},grid:{left:52,right:25,top:55,bottom:38},xAxis:{type:'category',data:dates,axisLine:{lineStyle:{color:line}},axisLabel:{color:muted},axisTick:{show:false}},yAxis:{type:'value',axisLabel:{color:muted},splitLine:{lineStyle:{color:line}}}};
  const init=(id,option)=>{const el=$('#'+id);const chart=echarts.init(el,dark?'dark':null,{renderer:'svg'});chart.setOption({...common,...option});charts.push(chart);};
  if(managedOn()&&mode==='managed'&&unit==='credits'){
   $('#tokens-title').textContent='每日积分消耗';$('#tokens-note').textContent='1 积分 = '+Number(credit.tokens_per_credit).toLocaleString('zh-CN')+' tokens';
   init('chart-tokens',{legend:{...common.legend,data:['积分消耗']},series:[{name:'积分消耗',type:'bar',stack:'credits',data:data.daily.map(d=>+(d.managed_tokens/credit.tokens_per_credit).toFixed(3))}]});
  }else{
   $('#tokens-title').textContent='每日 Token 消耗';$('#tokens-note').textContent='接口实际返回的 usage';
   init('chart-tokens',{legend:{...common.legend,data:['输入','输出','仅上报总量']},series:[{name:'输入',type:'bar',stack:'tokens',data:data.daily.map(d=>d.prompt_tokens)},{name:'输出',type:'bar',stack:'tokens',data:data.daily.map(d=>d.completion_tokens)},{name:'仅上报总量',type:'bar',stack:'tokens',data:data.daily.map(d=>Math.max(0,d.total_tokens-d.prompt_tokens-d.completion_tokens))}]});
  }
  init('chart-latency',{series:[{name:'平均响应',type:'line',showSymbol:false,data:data.daily.map(d=>d.average_ms==null?null:+(d.average_ms/1000).toFixed(2))},{name:'P95',type:'line',showSymbol:false,data:data.daily.map(d=>d.p95_ms==null?null:+(d.p95_ms/1000).toFixed(2))},{name:'首字',type:'line',showSymbol:false,data:data.daily.map(d=>d.first_token_ms==null?null:+(d.first_token_ms/1000).toFixed(2))}]});
  init('chart-status',{color:[green,styles.getPropertyValue('--red-text').trim()],yAxis:{...common.yAxis,minInterval:1},series:[{name:'成功',type:'bar',stack:'calls',data:data.daily.map(d=>d.success)},{name:'失败或取消',type:'bar',stack:'calls',data:data.daily.map(d=>d.failed)}]});
  observer=new ResizeObserver(()=>requestAnimationFrame(()=>charts.forEach(c=>{if(!c.isDisposed())c.resize();})));for(const id of ['chart-tokens','chart-latency','chart-status'])observer.observe($('#'+id));
 }
 function paint(data,animate=false){if(animate)return uiMotion.relayout($('#view'),()=>paint(data));const t=data.total;const managed=managedOn()&&mode==='managed';const cards=[];
  const creditHost=$('#statistics-credit');
  creditHost.hidden=!managed;
  creditHost.innerHTML=managed?'<section class="panel credit-panel"><span class="helper">可用积分</span><strong>'+creditText(credit.balance)+'</strong><p class="helper">1 积分 = '+num(credit.tokens_per_credit)+' tokens</p><span class="service-badge">服务器提供 · 免配置</span></section>'+(credit.checkin_enabled?'<section class="panel checkin-panel"><div><h3>每日签到</h3><p class="helper">'+(credit.checked_today?'明天再来，继续领取积分。':'每天领取 '+num(credit.checkin_credits)+' 积分')+'</p></div><strong>'+(credit.checked_today?'今日已签到':'+'+num(credit.checkin_credits)+' 积分')+'</strong>'+(credit.checked_today?'':'<button class="secondary" data-credit-checkin>立即签到</button>')+'</section>':''):'';
  $('#statistics-unit').hidden=!managed;
  $$('[data-stat-unit]').forEach(b=>{const on=b.dataset.statUnit===unit;b.classList.toggle('active',on);b.setAttribute('aria-selected',String(on));b.tabIndex=on?0:-1;});
  if(managed)cards.push(metric('已消耗积分',creditText(t.managed_tokens/credit.tokens_per_credit),'当前统计范围 · '+num(t.total_tokens)+' tokens'));
  if(!managed)cards.push(metric('已知 Token 消耗',num(t.total_tokens),t.unreported?num(t.unreported)+' 次调用未上报 Token':'输入 '+num(t.prompt_tokens)+' · 输出 '+num(t.completion_tokens)));
  cards.push(metric('模型调用',num(t.calls),'通知分析和文件整理'),metric('成功率',t.success_rate==null?'—':t.success_rate+'%',num(t.success)+' 次成功 · '+num(t.failed)+' 次失败/取消'),metric('平均响应',seconds(t.average_ms),'仅统计成功请求'));
  $('#statistics-summary').innerHTML=cards.join('');
  $('#statistics-recent').innerHTML='<table><thead><tr><th>时间</th><th>功能 / 模型</th><th>结果</th><th>Token</th><th>首字</th><th>总耗时</th></tr></thead><tbody>'+data.recent.map(r=>'<tr><td>'+formatDate(r.started_at)+'</td><td>'+esc(r.kind==='file'?'文件整理':'通知分析')+'<small>'+esc(r.model)+(r.streamed===1?' · 流式':r.streamed===0?' · 完整响应':'')+'</small></td><td>'+esc(statusName[r.status]||r.status)+(r.http_status?' · '+r.http_status:'')+'</td><td>'+(r.usage_reported?num(r.total_tokens):'未上报')+'</td><td>'+seconds(r.first_token_ms)+'</td><td>'+seconds(r.duration_ms)+'</td></tr>').join('')+'</tbody></table>'+(!data.recent.length?'<div class="empty"><strong>还没有模型调用记录</strong><p>分析一条通知或整理一份文件后，统计会出现在这里。</p></div>':'');
  $('#statistics-models').innerHTML=data.models.length?'<section class="panel statistics-models"><div class="panel-head"><h3>按模型汇总</h3></div><div class="statistics-table"><table><thead><tr><th>模型</th><th>调用</th><th>已知 Token</th><th>未上报</th></tr></thead><tbody>'+data.models.map(m=>'<tr><td>'+esc(m.model)+'</td><td>'+num(m.calls)+'</td><td>'+num(m.total_tokens)+'</td><td>'+num(m.unreported)+'</td></tr>').join('')+'</tbody></table></div></section>':'';
  uiMotion.syncSegments();draw(data);
 }
 async function load(){const current=++epoch;try{
  if($('#statistics-state'))$('#statistics-state').textContent='正在读取统计…';
  const c=await api('/api/ai/credit').catch(()=>null);
  if(current!==epoch||state.page!=='stats')return;
  credit=c;syncMode();
  const [data]=await Promise.all([api('/api/statistics?days='+days+'&source='+mode),library()]);
  if(current!==epoch||state.page!=='stats')return;
  paint(data,!!lastData);$('#statistics-state').textContent='已更新 · '+new Date().toLocaleTimeString('zh-CN');
 }catch(error){if(current===epoch&&state.page==='stats'&&$('#statistics-state'))$('#statistics-state').textContent=error.message;}}
 function mount(){if($('#statistics-days'))$('#statistics-days').value=String(days);load();}
 function unmount(){epoch++;dispose();lastData=null;}
 document.addEventListener('click',e=>{const unitTab=e.target.closest('[data-stat-unit]');if(unitTab){unit=unitTab.dataset.statUnit;if(lastData)paint(lastData);return;}const tab=e.target.closest('[data-chart-mode]');if(tab?.classList.contains('active'))return;if(tab){mode=tab.dataset.chartMode;modeChosen=true;$$('[data-chart-mode]').forEach(b=>{const on=b.dataset.chartMode===mode;b.classList.toggle('active',on);b.setAttribute('aria-selected',String(on));b.tabIndex=on?0:-1;});uiMotion.syncSegments();load();uiMotion.transitionPage($('#statistics-summary'),true);return;}if(e.target.closest('[data-statistics-refresh]'))load();});document.addEventListener('change',e=>{if(e.target.id==='statistics-days'){days=Number(e.target.value);load();}});window.addEventListener('appearance-changed',()=>{if(state.page==='stats'&&lastData)draw(lastData);});window.addEventListener('credit-changed',()=>{if(state.page==='stats')load();});setInterval(()=>{if(state.session&&state.page==='stats')load();},15000);
 window.statistics={page,mount,unmount};
})();
