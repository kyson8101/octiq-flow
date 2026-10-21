import {expect,it} from 'vitest';
import {activityOf,likesActivity} from './interactions';
import {hobbiesFor} from './hobbies';
import type {Asset} from './model';
const asset=(name:string,kind:Asset['kind']='decor',use?:Asset['use']):Asset=>({id:name,rev:1,name,kind,use,parts:[],by:{name:'Maker'},madeAt:0,updatedAt:0});
it('gives old real-world gifts appropriate interactions without rewriting saved data',()=>{
 for(const [name,activity] of [['奶油黄海景画架','paint'],['Pine Library Bookshelf','read'],['Cherry-wood windowsill herb planter','garden'],['星光合奏公共音乐亭','perform'],['Mint Seedling Greenhouse · Open Sky','garden'],['Brass Evening Lamp','observe']])expect(activityOf(asset(name))).toBe(activity);
 expect(activityOf(asset('Oak desk for letters to the sea','furniture','desk'))).toBe('read');
 expect(activityOf(asset('白漆齿轮工作台','furniture','desk'))).toBe('play');
 expect(activityOf(asset('Plain gift'))).toBe('observe');
 expect(activityOf(asset('Hat','accessory'))).toBeNull();
 expect(activityOf(asset('Static sculpture','decor','none'))).toBeNull();
 expect(activityOf(asset('A different name','building','perform'))).toBe('perform');
});
it('gives stable varied hobbies and reserves planting for robots that enjoy gardening',()=>{
 const hobbies=Array.from({length:30},(_,i)=>hobbiesFor(`agent-${i}`));
 expect(hobbies.some(h=>h.includes('gardening'))).toBe(true);expect(hobbies.some(h=>!h.includes('gardening'))).toBe(true);
 expect(hobbiesFor('maya')).toEqual(hobbiesFor('maya'));
 expect(likesActivity(['reading'],'garden')).toBe(false);expect(likesActivity(['gardening'],'garden')).toBe(true);
});
