"""从 pose_raw.json 提取 20 个动作(5组x4)的模板 -> templates.json"""
import json, numpy as np, collections
d=json.load(open('pose_raw.json'))
segs=[(9.7,47.5),(56.5,94.5),(103.4,141.3),(150.6,186.9),(196.4,233.0),(242.4,279.4),(288.9,323.4),(333.2,368.1),(376.9,413.1),(422.3,456.7),(465.5,500.5),(509.8,546.7),(556.3,592.9),(601.8,638.2),(647.1,682.3),(692.0,729.3),(741.5,778.2),(787.4,824.6),(833.9,868.9),(877.9,914.1)]
NAMES=['胯下击掌','提膝下压','对侧提膝','同侧提膝']
LIFT_THR=0.0    # knee 相对 hip 的归一化高度,<该值才算抬起(与前端一致)
STD_FLOOR=0.22
def P(x,i): return np.array([x["p"][i][0]*0.5625,x["p"][i][1]])
def feat(x,side):
    ls,rs,lh,rh,lk,rk,lw,rw,le,re=[P(x,j) for j in (11,12,23,24,25,26,15,16,13,14)]
    T=np.linalg.norm((ls+rs)/2-(lh+rh)/2)+1e-6
    L=side=='L'
    kk=lk if L else rk; hh=lh if L else rh
    sw,ow=(lw,rw) if L else (rw,lw); se,oe=(le,re) if L else (re,le)
    n=lambda a,b:float(np.linalg.norm(a-b)/T)
    return [n(sw,kk),n(ow,kk),n(se,kk),n(oe,kk),float(abs(lw[0]-rw[0])/T),float(((lw[1]+rw[1])/2-(lh[1]+rh[1])/2)/T),float((min(lw[1],rw[1])-kk[1])/T)]
def knee(x,side):
    a,b=(25,23) if side=='L' else (26,24)
    T=np.linalg.norm((P(x,11)+P(x,12))/2-(P(x,23)+P(x,24))/2)+1e-6
    return float((P(x,a)[1]-P(x,b)[1])/T)
def peaks(sig,mind=3):
    r=[];last=-99
    for i in range(1,len(sig)-1):
        if sig[i]<LIFT_THR and sig[i]<=sig[i-1] and sig[i]<sig[i+1] and i-last>=mind: r.append(i);last=i
    return r
acc=collections.defaultdict(list)
segout=[]
for k,(a,b) in enumerate(segs):
    m=k%4
    fr=[x for x in d if a<=x['t']<=b and x['p']]
    for side in 'LR':
        kn=[knee(x,side) for x in fr]
        for i in peaks(kn): acc[m].append(feat(fr[i],side)+[kn[i]])
    segout.append({'group':k//4,'move':m,'name':NAMES[m],'start':a,'end':b})
tpl=[]
for m in range(4):
    A=np.array(acc[m])
    tpl.append({'name':NAMES[m],'mean':A.mean(0).round(3).tolist(),'std':np.maximum(A.std(0),STD_FLOOR).round(3).tolist(),'samples':len(A)})
def score(t,f):
    return float(np.mean(np.abs((np.array(f)-np.array(t['mean']))/np.array(t['std']))))
# 自检: 参考视频自身的混淆矩阵 (阈值 ACCEPT)
ACCEPT=1.8
conf=np.zeros((4,4)); own_ok=0; tot=0
for m in range(4):
    for f in acc[m]:
        sc=[score(tpl[j],f) for j in range(4)]
        conf[m][int(np.argmin(sc))]+=1
        own_ok+= sc[m]<ACCEPT; tot+=1
print(conf.astype(int)); print('own accept rate',own_ok/tot)
json.dump({'segments':segout,'templates':tpl,'liftThr':LIFT_THR,'accept':ACCEPT,'reps':20,'restSec':10,
 'featNames':['同侧腕-膝','对侧腕-膝','同侧肘-膝','对侧肘-膝','双腕间距','腕高(相对髋)','最高腕-膝高差','膝高']},
 open('templates.json','w',encoding='utf-8'),ensure_ascii=False,indent=1)
