<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { onContentUpdated } from 'vitepress'
import Annotations from './Annotations.vue'
import InkLayer from './InkLayer.vue'
const size=ref(17), progress=ref(0), outline=ref(false)
const leftHidden=ref(false), rightHidden=ref(false)
const headings=ref<{id:string;text:string;level:number}[]>([])
let frame=0
function apply(){
 const el=document.documentElement
 el.classList.toggle('os-left-hidden',leftHidden.value)
 el.classList.toggle('os-right-hidden',rightHidden.value)
 el.style.setProperty('--reading-size',size.value+'px')
 try{localStorage.setItem('os-reading',JSON.stringify({size:size.value,left:leftHidden.value,right:rightHidden.value}))}catch{}
}
function toggleOutline(){
 // 窄屏（手机/平板竖屏）：展开抽屉式目录；宽屏：收起/展开整个右侧栏
 if(window.matchMedia('(max-width: 1199px)').matches){ outline.value=!outline.value }
 else rightHidden.value=!rightHidden.value
}
function jumpToHeading(id:string){
 outline.value=false
 document.getElementById(id)?.scrollIntoView()
}
function showNavigation(){leftHidden.value=false}
function measure(){
 cancelAnimationFrame(frame)
 frame=requestAnimationFrame(()=>{const el=document.querySelector('.vp-doc') as HTMLElement;if(!el)return;const start=el.getBoundingClientRect().top+scrollY;progress.value=Math.max(0,Math.min(100,100*(scrollY-start)/(Math.max(1,el.offsetHeight-innerHeight))))})
}
async function refresh(){await nextTick();headings.value=[...document.querySelectorAll('.vp-doc h2,.vp-doc h3')].map(el=>({id:el.id,text:el.textContent?.replace(/\u200b/g,'').trim()||'',level:Number(el.tagName[1])}));outline.value=false;measure()}
onMounted(()=>{
 try{const saved=JSON.parse(localStorage.getItem('os-reading')||'{}');if([16,17,18,19,20].includes(saved.size))size.value=saved.size;leftHidden.value=saved.left===true;rightHidden.value=saved.right===true}catch{}
 apply();refresh();window.addEventListener('scroll',measure,{passive:true});window.addEventListener('resize',measure);window.addEventListener('reader-show-navigation',showNavigation)
})
watch([size,leftHidden,rightHidden],apply)
onContentUpdated(refresh)
onBeforeUnmount(()=>{window.removeEventListener('scroll',measure);window.removeEventListener('resize',measure);window.removeEventListener('reader-show-navigation',showNavigation);cancelAnimationFrame(frame);document.documentElement.classList.remove('os-left-hidden','os-right-hidden')})
</script>
<template>
 <div class="reading-tools">
  <div class="reading-controls" aria-label="阅读设置">
   <button type="button" class="left-toggle" @click="leftHidden=!leftHidden" :aria-pressed="leftHidden">章节列表 <span>{{leftHidden?'＋':'−'}}</span></button>
   <button type="button" @click="toggleOutline" :aria-pressed="rightHidden" :aria-expanded="outline" aria-controls="chapter-outline">本讲大纲 <span>{{(rightHidden||outline)?'＋':'−'}}</span></button>
   <span class="tool-sep" aria-hidden="true"></span>
   <Annotations />
   <InkLayer />
   <div class="font-controls"><button @click="size=Math.max(16,size-1)" :disabled="size===16" aria-label="减小字号">A−</button><span aria-live="polite">{{size}}</span><button @click="size=Math.min(20,size+1)" :disabled="size===20" aria-label="增大字号">A＋</button></div>
  </div>
  <nav v-if="outline" id="chapter-outline" class="chapter-outline" aria-label="本讲章节"><a v-for="h in headings" :key="h.id" :href="'#'+h.id" :class="{'subheading':h.level===3}" @click.prevent="jumpToHeading(h.id)">{{h.text}}</a></nav>
  <div class="reading-progress" role="progressbar" aria-label="阅读进度" :aria-valuenow="Math.round(progress)" :aria-valuemin="0" :aria-valuemax="100"><span :style="{width:progress+'%'}" /></div>
 </div>
</template>
