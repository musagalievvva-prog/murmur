import {getStore} from '@netlify/blobs';
import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});
const store=()=>getStore('fivevoices-v2');
const key=(kind,id)=>`${kind}-${id}`;
const code=()=>randomBytes(5).toString('hex').toUpperCase();
const digest=s=>createHash('sha256').update(String(s)).digest('hex');
const same=(a,b)=>{const x=Buffer.from(String(a)),y=Buffer.from(String(b));return x.length===y.length&&timingSafeEqual(x,y)};
const clean=s=>String(s??'').trim().slice(0,12000);
const read=async(k)=>await store().get(k,{type:'json'});
const put=async(k,v)=>store().setJSON(k,v);
export default async(req)=>{
try{
 if(req.method==='GET' && new URL(req.url).searchParams.get('ping')) return json({ok:true,mode:'cloud'});
 if(req.method!=='POST')return json({error:'Метод не поддерживается'},405);
 let body=await req.json();let action=body.action;
 if(action==='create'){
  const l=body.lesson||{};if(!clean(l.text)||!clean(l.title)||!Array.isArray(l.qs)||l.qs.length!==5)return json({error:'Заполните текст и вопросы пяти ролей'},400);
  const id=code(),secret=randomBytes(24).toString('hex');
  const lesson={title:clean(l.title).slice(0,160),grade:String(l.grade||'6'),text:clean(l.text),qs:l.qs.map(x=>Array.isArray(x)?x.slice(0,2).map(v=>clean(v).slice(0,400)):['',''])};
  await put(key('lesson',id),{...lesson,secretHash:digest(secret),created:Date.now()});
  await put(key('session',id),{id,answers:[],closed:false,created:Date.now()});
  return json({id,secret});
 }
 const id=clean(body.id).toUpperCase();if(!/^[A-F0-9]{10}$/.test(id))return json({error:'Неверный код занятия'},400);
 const lesson=await read(key('lesson',id));if(!lesson)return json({error:'Занятие не найдено'},404);
 const sess=await read(key('session',id));
 if(action==='join')return json({lesson:{title:lesson.title,grade:lesson.grade,text:lesson.text,qs:lesson.qs},closed:sess?.closed||false});
 if(action==='submit'){
  if(sess?.closed)return json({error:'Приём ответов закрыт'},403);
  const role=Number(body.role),name=clean(body.name).slice(0,55),answer=clean(body.answer).slice(0,3000),evidence=clean(body.evidence).slice(0,1200);
  if(!name||!answer||!evidence||!Number.isInteger(role)||role<0||role>4)return json({error:'Заполните имя, ответ и доказательство'},400);
  const a={role,name,answer,evidence,time:new Date().toISOString(),id:code()};
  // Each response stored separately to avoid overwriting simultaneous submissions.
  await put(key(`answer-${id}`,a.id),a);return json({ok:true});
 }
 const secret=clean(body.secret);if(!same(digest(secret),lesson.secretHash))return json({error:'Неверный ключ учителя'},403);
 if(action==='results'){
  const {blobs}=await store().list({prefix:key(`answer-${id}`,'')});
  const answers=(await Promise.all(blobs.slice(0,500).map(b=>read(b.key)))).filter(Boolean).sort((a,b)=>a.time.localeCompare(b.time));
  return json({lesson:{title:lesson.title,grade:lesson.grade,text:lesson.text,qs:lesson.qs},answers,closed:sess?.closed||false});
 }
 if(action==='close'){await put(key('session',id),{...sess,closed:!!body.closed});return json({ok:true});}
 return json({error:'Неизвестная операция'},400);
}catch(e){return json({error:'Серверная ошибка. Проверьте настройки Netlify Blobs.'},500)}
};
export const config={path:'/api'};
