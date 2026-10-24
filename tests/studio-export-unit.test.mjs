// Browser lifecycle unit tests with fake media APIs, not codec/output validation.
// Real recorded-video validation lives in studio-export.cjs.
import assert from 'node:assert/strict';
const elements = new Set(), urls = new Set(), tracks = new Set();
class FakeStream extends EventTarget {
 constructor() {super(); this.tracks=['video','audio'].map(kind=>({kind,readyState:'live',stop(){this.readyState='ended';tracks.delete(this);}})); this.tracks.forEach(t=>tracks.add(t));}
 getTracks(){return this.tracks;} getVideoTracks(){return this.tracks.filter(t=>t.kind==='video');} getAudioTracks(){return this.tracks.filter(t=>t.kind==='audio');}
}
class Video extends EventTarget {
 constructor(){super();this.style={};this._time=0;this.readyState=0;this.duration=6;this.videoWidth=320;this.videoHeight=180;this.webkitAudioDecodedByteCount=100;this.paused=true;}
 setAttribute(){} removeAttribute(){this.src='';} remove(){elements.delete(this);} captureStream(){return new FakeStream();}
 load(){this.pause();if(!this.src)return;queueMicrotask(()=>{this.readyState=2;this.dispatchEvent(new Event('loadeddata'));});}
 set currentTime(v){this._time=v;this.seeking=true;queueMicrotask(()=>{this.seeking=false;this.dispatchEvent(new Event('seeked'));});}
 get currentTime(){return this._time;}
 play(){this.paused=false;this.timer=setInterval(()=>{this._time+=.02; if(this._time>=6){this._time=6;this.ended=true;this.pause();this.dispatchEvent(new Event('ended'));}},20);return Promise.resolve();}
 pause(){this.paused=true;clearInterval(this.timer);}
}
class Recorder extends EventTarget {
 static isTypeSupported(type){return type.startsWith('video/webm');}
 constructor(stream,options){super();this.stream=stream;this.mimeType=options.mimeType;this.state='inactive';}
 start(){this.state='recording';} stop(){this.state='inactive';queueMicrotask(()=>{this.dispatchEvent(Object.assign(new Event('dataavailable'),{data:new Blob(['mock-video'],{type:this.mimeType})}));this.dispatchEvent(new Event('stop'));});}
}
const document=new EventTarget();document.hidden=false;document.createElement=()=>new Video();document.body={append:v=>elements.add(v)};
globalThis.document=document;globalThis.HTMLVideoElement=Video;globalThis.MediaRecorder=Recorder;
const create=URL.createObjectURL, revoke=URL.revokeObjectURL;
URL.createObjectURL=b=>{let u=create(b);urls.add(u);return u;};URL.revokeObjectURL=u=>{urls.delete(u);revoke(u);};
const {exportClip,getExportCapability}=await import('../studio/export.mjs');
const file=new Blob(['fixture']);
const clean=()=>assert.deepEqual([elements.size,urls.size,tracks.size],[0,0,0]);
assert.equal(getExportCapability().supported,true);
for(const phase of ['before','preparing','rendering','finalizing','complete']){
 const ac=new AbortController();if(phase==='before')ac.abort();
 await assert.rejects(exportClip({file,start:2,end:2.2,signal:ac.signal,onProgress:p=>{if(p.phase===phase)ac.abort();}}),e=>e.name==='AbortError');clean();
}
console.log('PASS abort at every phase with full cleanup');
const out=await exportClip({file,start:2,end:2.2});assert.match(out.mimeType,/webm/);assert.equal(out.extension,'webm');clean();
for(const data of [{file,start:2,end:1},{file,start:0,end:121},{file,start:0,end:7}]){await assert.rejects(exportClip(data));clean();}
console.log('PASS repeated export, range validation, output type, and cleanup (mocked APIs)');
const p=Video.prototype.play;Video.prototype.play=()=>Promise.reject(new DOMException('no','NotAllowedError'));
await assert.rejects(exportClip({file,start:2,end:2.2}),/blocked playback/);clean();Video.prototype.play=p;
const before=Recorder.prototype.stop;Recorder.prototype.stop=function(){this.state='inactive';queueMicrotask(()=>this.dispatchEvent(new Event('stop')));};
await assert.rejects(exportClip({file,start:2,end:2.2}),/empty recording/);clean();Recorder.prototype.stop=before;
console.log('PASS explicit autoplay and empty-recorder failures');
const abort=new AbortController();
const outcomes=await Promise.allSettled([exportClip({file,start:2,end:2.2,signal:abort.signal,onProgress:p=>{if(p.phase==='rendering')abort.abort();}}),exportClip({file,start:3,end:3.2})]);
assert.equal(outcomes[0].reason.name,'AbortError');assert.equal(outcomes[1].status,'fulfilled');clean();
console.log('PASS concurrent export isolation');
