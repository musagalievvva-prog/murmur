import {getStore} from '@netlify/blobs';
import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});
const store=()=>getStore({name:'fivevoices-v2',consistency:'strong'});
const key=(kind,id)=>`${kind}-${id}`;
const code=()=>randomBytes(5).toString('hex').toUpperCase();
const digest=s=>createHash('sha256').update(String(s)).digest('hex');
const same=(a,b)=>{const x=Buffer.from(String(a)),y=Buffer.from(String(b));return x.length===y.length&&timingSafeEqual(x,y)};
const clean=(s,n=12000)=>String(s??'').trim().slice(0,n);
const read=async(k)=>await store().get(k,{type:'json'});
const put=async(k,v)=>store().setJSON(k,v);
const validQuestions=qs=>Array.isArray(qs)&&qs.length===5&&qs.every(q=>Array.isArray(q)&&q.length===2&&q.every(s=>typeof s==='string'&&s.trim()&&s.length<=400));
function sanitize(l){if(!l||!clean(l.text)||!clean(l.title)||!validQuestions(l.qs))throw Error('VALIDATION');return {title:clean(l.title,160),grade:['5','6','7'].includes(String(l.grade))?String(l.grade):'6',mode:['class','solo','home'].includes(l.mode)?l.mode:'class',text:clean(l.text),qs:l.qs.map(q=>q.map(s=>clean(s,400)))}}
async function limited(req,action,max){const ip=req.headers.get('x-nf-client-connection-ip')||req.headers.get('x-forwarded-for')?.split(',')[0]||'unknown';const k=`quota-${action}-${new Date().toISOString().slice(0,10)}-${digest(ip).slice(0,24)}`;const count=(await read(k))?.count||0;if(count>=max)return false;await put(k,{count:count+1});return true}
export default async(req)=>{
try{
 if(req.method==='GET'&&new URL(req.url).searchParams.get('ping'))return json({ok:true,mode:'cloud',version:'2.1'});
 if(req.method!=='POST')return json({error:'Метод не поддерживается'},405);
 if(req.headers.get('content-length')&&Number(req.headers.get('content-length'))>50000)return json({error:'Слишком большой запрос'},413);
 const body=await req.json();const action=body.action;
 if(action==='publicList'){const {blobs}=await store().list({prefix:'public-'});const lessons=(await Promise.all(blobs.slice(0,300).map(b=>read(b.key)))).filter(Boolean).filter(l=>l.visible!==false).map(({secretHash,...l})=>l).sort((a,b)=>b.created-a.created);return json({lessons})}
 if(action==='publish'){
  if(body.consent!==true||!clean(body.author,60))return json({error:'Подтвердите право на публикацию и укажите автора'},400);
  const l=sanitize(body.lesson);if(!await limited(req,'publish',5))return json({error:'Лимит: пять публикаций в день'},429);
  const id=code(),secret=randomBytes(24).toString('hex');await put('public-'+id,{...l,id,author:clean(body.author,60),created:Date.now(),secretHash:digest(secret),visible:true});return json({id,secret});
 }
 if(action==='unpublish'){const id=clean(body.id,10);if(!/^[A-F0-9]{10}$/.test(id))return json({error:'Неверный код'},400);const entry=await read('public-'+id);if(!entry||!same(digest(body.secret||''),entry.secretHash))return json({error:'Снять публикацию может только её автор на исходном устройстве'},403);await put('public-'+id,{...entry,visible:false});return json({ok:true})}
 if(action==='create'){
  const l=sanitize(body.lesson);const id=code(),secret=randomBytes(24).toString('hex');
  await put(key('lesson',id),{...l,secretHash:digest(secret),created:Date.now()});await put(key('session',id),{id,closed:false,created:Date.now()});return json({id,secret});
 }
 const id=clean(body.id,10).toUpperCase();if(!/^[A-F0-9]{10}$/.test(id))return json({error:'Неверный код занятия'},400);
 const lesson=await read(key('lesson',id));if(!lesson)return json({error:'Занятие не найдено'},404);
 const {secretHash,...safeLesson}=lesson;const sess=await read(key('session',id));
 if(action==='join')return json({lesson:safeLesson,closed:sess?.closed||false});
 if(action==='submit'){
  if(sess?.closed)return json({error:'Приём ответов закрыт'},403);
  const role=Number(body.role),name=clean(body.name,55),answer=clean(body.answer,3000),evidence=clean(body.evidence,1200);
  if(!name||!answer||!evidence||!Number.isInteger(role)||role<0||role>4)return json({error:'Заполните имя, ответ и доказательство'},400);
  const a={role,name,answer,evidence,time:new Date().toISOString(),id:code()};await put(key(`answer-${id}`,a.id),a);return json({ok:true});
 }
 if(!same(digest(clean(body.secret)),secretHash))return json({error:'Неверный ключ учителя'},403);
 if(action==='results'){
  const {blobs}=await store().list({prefix:key(`answer-${id}`,'')});const answers=(await Promise.all(blobs.slice(0,500).map(b=>read(b.key)))).filter(Boolean).sort((a,b)=>a.time.localeCompare(b.time));
  const grades=Object.fromEntries((await Promise.all(answers.map(async a=>[a.id,await read(`grade-${id}-${a.id}`)]))).filter(([,g])=>g));return json({lesson:safeLesson,answers,grades,closed:sess?.closed||false});
 }
 if(action==='grade'){
  if(!Array.isArray(body.scores)||body.scores.length!==4||body.scores.some(n=>!Number.isInteger(n)||n<0||n>2))return json({error:'Каждый критерий: 0, 1 или 2 балла'},400);
  const aid=clean(body.answerId,10);if(!/^[A-F0-9]{10}$/.test(aid)||!await read(`answer-${id}-${aid}`))return json({error:'Ответ не найден'},404);
  await put(`grade-${id}-${aid}`,{scores:body.scores,note:clean(body.note,600),updated:Date.now()});return json({ok:true});
 }
 if(action==='close'){await put(key('session',id),{...sess,closed:!!body.closed});return json({ok:true})}
 return json({error:'Неизвестная операция'},400);
}catch(e){return json({error:e.message==='VALIDATION'?'Заполните название, текст и два вопроса для каждой из пяти ролей.':'Не удалось выполнить операцию. Повторите попытку.'},e.message==='VALIDATION'?400:500)}
};
export const config={path:'/api'};
