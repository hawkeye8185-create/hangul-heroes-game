import { DurableObject } from 'cloudflare:workers';

const MAX_MEMBERS = 40;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const QUESTIONS = [
  { id:'m1', q:'이제 집에 가도 (   )?', options:['되요','돼요','됬어요','되였어요'], answer:1, tip:"'되어요'를 줄이면 '돼요'입니다." },
  { id:'m2', q:'오늘은 비가 오지 (   ).', options:['안아요','않아요','안하요','안나요'], answer:1, tip:"'오지 않아요'처럼 '않다'를 써요." },
  { id:'m3', q:'책을 가방에 (   ).', options:['넣었어요','너었어요','넛었어요','너였어요'], answer:0, tip:"'넣다'의 과거형은 '넣었어요'예요." },
  { id:'m4', q:'책상 위에 연필이 (   ).', options:['있어요','잇어요','이써요','잇서요'], answer:0, tip:"'있다'는 '있어요'로 활용합니다." },
  { id:'m5', q:'나는 엄마와 함께 시장에 (   ).', options:['갓어요','갔어요','가써요','갔서요'], answer:1, tip:"'가다'의 과거형은 '갔어요'입니다." },
  { id:'m6', q:'이 문제를 (   ) 풀었어요.', options:['맞게','맏게','맛게','맡게'], answer:0, tip:"'맞다'에 '-게'가 붙은 '맞게'가 알맞아요." },
  { id:'m7', q:'공부를 열심히 (   ).', options:['했어요','햇어요','해써요','햇서요'], answer:0, tip:"'하다'의 과거형은 '했어요'입니다." },
  { id:'m8', q:'친구가 나에게 (   ) 말했어요.', options:['고맙다고','고맙다구','고맙타고','고맙따고'], answer:0, tip:"'고맙다'에 '-고'를 붙인 말은 '고맙다고'입니다." },
  { id:'m9', q:'나는 친구와 (   ) 놀았어요.', options:['함께','함깨','함게','항께'], answer:0, tip:"'함께'가 올바른 표기입니다." },
  { id:'m10', q:'정말 (   ) 날이에요!', options:['즐거운','즐꺼운','즐거은','즐거웅'], answer:0, tip:"'즐겁다'의 관형형은 '즐거운'입니다." },
  { id:'m11', q:'나는 오늘 (   ) 일어났어요.', options:['일찍','일직','일찎','일찍이'], answer:0, tip:"이 문장에는 '일찍'이 자연스럽습니다." },
  { id:'m12', q:'오늘 숙제를 다 (   ).', options:['끝냈어요','끝낫어요','끝네써요','끈냈어요'], answer:0, tip:"'끝내다'의 과거형은 '끝냈어요'입니다." }
];
const json = (data, status=200) => new Response(JSON.stringify(data), { status, headers: { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' } });
function randomString(len){ const bytes=crypto.getRandomValues(new Uint8Array(len)); return Array.from(bytes,b=>ALPHABET[b%ALPHABET.length]).join(''); }
function shuffle(a){ const b=[...a]; for(let i=b.length-1;i>0;i--){const r=crypto.getRandomValues(new Uint32Array(1))[0]%(i+1);[b[i],b[r]]=[b[r],b[i]];}return b; }
function safeName(v){return String(v||'').normalize('NFC').trim().replace(/[<>\\\r\n\t]/g,'').slice(0,16);}

export default {
 async fetch(request, env){
   const url = new URL(request.url);
   if(url.pathname==='/api/create' && request.method==='POST'){
     for(let n=0;n<6;n++){
       const code=randomString(6), token=crypto.randomUUID()+crypto.randomUUID();
       const stub=env.ROOMS.getByName(code);
       const res=await stub.fetch(new Request('https://room/init', {method:'POST', body:JSON.stringify({token})}));
       if(res.status===201)return json({code,hostToken:token,capacity:MAX_MEMBERS},201);
     }
     return json({error:'방 생성에 실패했습니다. 다시 시도해주세요.'},503);
   }
   if(url.pathname==='/ws'){
     const code=(url.searchParams.get('code')||'').trim().toUpperCase();
     if(!/^[A-HJ-NP-Z2-9]{6}$/.test(code))return json({error:'올바른 6자리 코드가 아닙니다.'},400);
     if(request.headers.get('Upgrade')!=='websocket')return json({error:'WebSocket 연결이 필요합니다.'},426);
     return env.ROOMS.getByName(code).fetch(new Request('https://room/connect',{headers:request.headers}));
   }
   if(url.pathname.startsWith('/api/'))return json({error:'잘못된 API입니다.'},404);
   return env.ASSETS.fetch(request);
 }
};

export class GameRoom extends DurableObject {
  constructor(ctx, env){super(ctx,env);this.ctx=ctx;}
  async state(){return await this.ctx.storage.get('room') || null;}
  async save(room){await this.ctx.storage.put('room',room);}
  sockets(){return this.ctx.getWebSockets().filter(s=>s.readyState===1);}
  send(ws,obj){try{ws.send(JSON.stringify(obj));}catch{}}
  broadcast(obj){for(const ws of this.sockets())this.send(ws,obj);}
  async fetch(request){
    const pathname=new URL(request.url).pathname;
    if(pathname==='/init'){
      if(await this.state())return json({error:'방 코드 중복'},409);
      const {token}=await request.json();
      await this.save({token, phase:'lobby',round:0,questionIds:[],members:[],answers:{},created:Date.now()});
      return json({ok:true},201);
    }
    if(pathname==='/connect'){
      const room=await this.state();
      if(!room || Date.now()-room.created > 86400000)return json({error:'존재하지 않거나 만료된 방입니다.'},404);
      const pair=new WebSocketPair();const [client,server]=Object.values(pair);
      this.ctx.acceptWebSocket(server);server.serializeAttachment({id:null,host:false});
      this.send(server,{type:'connected',message:'입장할 이름을 입력해주세요.'});
      return new Response(null,{status:101,webSocket:client});
    }
    return json({error:'not found'},404);
  }
  async webSocketMessage(ws,message){
    let data;try{data=JSON.parse(String(message));}catch{return;}
    const room=await this.state();if(!room)return;
    const attachment=ws.deserializeAttachment()||{id:null,host:false};
    if(data.type==='join' && !attachment.id){
      const name=safeName(data.name);
      if(!name){this.send(ws,{type:'error',message:'별명을 입력하세요.'});return;}
      if(room.phase!=='lobby'){this.send(ws,{type:'error',message:'게임 중에는 입장할 수 없습니다.'});return;}
      if(room.members.length>=MAX_MEMBERS){this.send(ws,{type:'error',message:'방이 가득 찼습니다.'});return;}
      const isHost=typeof data.hostToken==='string' && data.hostToken===room.token;
      if(!isHost && room.members.some(m=>m.name===name)){this.send(ws,{type:'error',message:'이미 사용 중인 별명입니다.'});return;}
      if(isHost && room.members.some(m=>m.host)){this.send(ws,{type:'error',message:'방장이 이미 접속 중입니다.'});return;}
      const id=crypto.randomUUID();ws.serializeAttachment({id,host:isHost});
      room.members.push({id,name,host:isHost,score:0});await this.save(room);
      this.send(ws,{type:'welcome',id,host:isHost});await this.publish(room);return;
    }
    if(!attachment.id)return;
    const member=room.members.find(m=>m.id===attachment.id);if(!member)return;
    if(data.type==='start' && attachment.host && room.phase==='lobby'){
      room.phase='playing';room.round=0;room.answers={};room.questionIds=shuffle(QUESTIONS.map(q=>q.id)).slice(0,10);
      for(const m of room.members)m.score=0;
      await this.save(room);await this.publish(room);return;
    }
    if(data.type==='answer' && room.phase==='playing'){
      const key=`${room.round}:${member.id}`;
      if(Object.hasOwn(room.answers,key))return;
      if(!Number.isInteger(data.option)||data.option<0||data.option>3)return;
      const question=QUESTIONS.find(q=>q.id===room.questionIds[room.round]);if(!question)return;
      room.answers[key]=data.option;
      const correct=question.answer===data.option;
      if(correct)member.score+=100;
      await this.save(room);
      this.send(ws,{type:'feedback',correct,tip:question.tip,correctOption:question.answer});
      await this.publish(room);
      return;
    }
    if(data.type==='next' && attachment.host && room.phase==='playing'){
      room.round++;
      if(room.round>=room.questionIds.length)room.phase='finished';
      await this.save(room);await this.publish(room);return;
    }
    if(data.type==='reset' && attachment.host){
      room.phase='lobby';room.round=0;room.questionIds=[];room.answers={};
      for(const m of room.members)m.score=0;
      await this.save(room);await this.publish(room);return;
    }
  }
  async publish(room){
    const q=room.phase==='playing'?QUESTIONS.find(q=>q.id===room.questionIds[room.round]):null;
    const leaderboard=room.members.map(m=>({name:m.name,score:m.score,host:m.host})).sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name,'ko'));
    const count=room.members.filter(m=>Object.hasOwn(room.answers,`${room.round}:${m.id}`)).length;
    this.broadcast({type:'state',phase:room.phase,round:room.round,total:room.questionIds.length,question:q?{text:q.q,options:q.options}:null,players:leaderboard,answered:count});
  }
  async webSocketClose(ws){await this.leave(ws);}
  async webSocketError(ws){await this.leave(ws);}
  async leave(ws){
    const a=ws.deserializeAttachment()||{};if(!a.id)return;
    const room=await this.state();if(!room)return;
    const before=room.members.length;room.members=room.members.filter(m=>m.id!==a.id);
    if(room.members.length!==before){await this.save(room);await this.publish(room);}
    try{ws.close(1000,'disconnected');}catch{}
  }
}
