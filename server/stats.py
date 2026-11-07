"""Owner-scoped LLM usage summaries; missing upstream usage stays unknown."""
from datetime import datetime,timedelta,timezone
import math

TZ=timezone(timedelta(hours=8))

def summarize(rows,days):
    today=datetime.now(TZ).date();start=today-timedelta(days=days-1)
    daily={str(start+timedelta(days=i)):{'date':str(start+timedelta(days=i)),'calls':0,'success':0,'failed':0,'prompt_tokens':0,'completion_tokens':0,'total_tokens':0,'unreported':0,'latencies':[],'first_tokens':[]} for i in range(days)}
    models={}
    for row in rows:
        day=datetime.fromisoformat(row['started_at']).astimezone(TZ).date().isoformat()
        if day not in daily:continue
        item=daily[day];item['calls']+=1;item['success' if row['status']=='success' else 'failed']+=1
        for field in ('prompt_tokens','completion_tokens','total_tokens'):item[field]+=row[field] or 0
        item['unreported']+=not row['usage_reported']
        if row['status']=='success':
            item['latencies'].append(row['duration_ms'])
            if row['first_token_ms'] is not None:item['first_tokens'].append(row['first_token_ms'])
        model=models.setdefault(row['model'],{'model':row['model'],'calls':0,'total_tokens':0,'unreported':0})
        model['calls']+=1;model['total_tokens']+=row['total_tokens'] or 0;model['unreported']+=not row['usage_reported']
    all_latencies=[n for item in daily.values() for n in item['latencies']]
    for item in daily.values():
        values=sorted(item.pop('latencies'));first=item.pop('first_tokens')
        item['average_ms']=round(sum(values)/len(values)) if values else None
        item['p95_ms']=round(values[max(0,math.ceil(len(values)*.95)-1)]) if values else None
        item['first_token_ms']=round(sum(first)/len(first)) if first else None
    result=list(daily.values());total={key:sum(d[key] for d in result) for key in ('calls','success','failed','prompt_tokens','completion_tokens','total_tokens','unreported')}
    total['success_rate']=round(total['success']/total['calls']*100,1) if total['calls'] else None
    total['average_ms']=round(sum(all_latencies)/len(all_latencies)) if all_latencies else None
    return {'days':days,'timezone':'Asia/Shanghai','daily':result,'total':total,'models':sorted(models.values(),key=lambda m:m['total_tokens'],reverse=True),'recent':[dict(r) for r in rows[:30]]}
