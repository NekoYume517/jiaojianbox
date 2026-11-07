async function readEvents(response,onProgress){
 const decoder=new TextDecoder();let buffer='',result,complete=false;
 function consume(block){let kind='message',data='';for(const line of block.split('\n')){if(line.startsWith('event:'))kind=line.slice(6).trim();else if(line.startsWith('data:'))data+=line.slice(5).trimStart();}if(!data)return;const value=JSON.parse(data);if(kind==='progress')onProgress(value);else if(kind==='result'){result=value;complete=true;}else if(kind==='error')throw Error(typeof value.message==='string'?value.message:'AI 分析失败');}
 for await(const chunk of response.body){buffer+=decoder.decode(chunk,{stream:true});buffer=buffer.replace(/\r\n/g,'\n');let end;while((end=buffer.indexOf('\n\n'))>=0){consume(buffer.slice(0,end));buffer=buffer.slice(end+2);}}
 if(!complete)throw Error('AI 分析连接中断，文件已保留');return result;
}
module.exports={readEvents};
