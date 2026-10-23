# Minimal TrueType reader: cmap 4/12, hmtx, loca, glyf (simple + composite), kern via GPOS pair (format 1/2) skipped.
import struct, sys, json
d=open(sys.argv[1],'rb').read()
num=struct.unpack('>H',d[4:6])[0]
T={}
for i in range(num):
    tag,cs,off,ln=struct.unpack('>4sIII',d[12+16*i:28+16*i]); T[tag.decode()]=(off,ln)
def u16(o): return struct.unpack('>H',d[o:o+2])[0]
def s16(o): return struct.unpack('>h',d[o:o+2])[0]
def u32(o): return struct.unpack('>I',d[o:o+4])[0]
head=T['head'][0]; upm=u16(head+18); locfmt=s16(head+50)
maxp=T['maxp'][0]; ng=u16(maxp+4)
hhea=T['hhea'][0]; nhm=u16(hhea+34)
hmtx=T['hmtx'][0]
def adv(g): return u16(hmtx+4*min(g,nhm-1))
os2=T['OS/2'][0]; cap=s16(os2+88) if u16(os2)>=2 else None
cmap=T['cmap'][0]; cmapmap={}
for i in range(u16(cmap+2)):
    pid,eid,off=struct.unpack('>HHI',d[cmap+4+8*i:cmap+12+8*i]); st=cmap+off; fmt=u16(st)
    if fmt==4:
        segx2=u16(st+6); ends=st+14; starts=ends+segx2+2; deltas=starts+segx2; ros=deltas+segx2
        for s in range(segx2//2):
            e=u16(ends+2*s); b=u16(starts+2*s); dl=s16(deltas+2*s); ro=u16(ros+2*s)
            for c in range(b,e+1):
                if c==0xFFFF: continue
                if ro==0: g=(c+dl)&0xFFFF
                else:
                    g=u16(ros+2*s+ro+2*(c-b)); g=(g+dl)&0xFFFF if g else 0
                cmapmap.setdefault(c,g)
loca=T['loca'][0]; glyf=T['glyf'][0]
def gl(g):
    if locfmt==0: a=u16(loca+2*g)*2; b=u16(loca+2*g+2)*2
    else: a=u32(loca+4*g); b=u32(loca+4*g+4)
    return glyf+a, b-a
def contours(g, dx=0, dy=0):
    o,ln=gl(g)
    if ln==0: return []
    nc=s16(o)
    if nc>=0:
        ends=[u16(o+10+2*i) for i in range(nc)]; il=u16(o+10+2*nc); p=o+12+2*nc+il
        n=ends[-1]+1 if ends else 0; flags=[]
        while len(flags)<n:
            f=d[p];p+=1;flags.append(f)
            if f&8:
                r=d[p];p+=1;flags+= [f]*r
        xs=[];x=0
        for f in flags:
            if f&2: v=d[p];p+=1; x+= v if f&16 else -v
            elif not f&16: x+=s16(p);p+=2
            xs.append(x)
        ys=[];y=0
        for f in flags:
            if f&4: v=d[p];p+=1; y+= v if f&32 else -v
            elif not f&32: y+=s16(p);p+=2
            ys.append(y)
        out=[];st=0
        for e in ends:
            out.append([(xs[i]+dx,ys[i]+dy,flags[i]&1) for i in range(st,e+1)]); st=e+1
        return out
    out=[];p=o+10
    while True:
        fl=u16(p); gi=u16(p+2); p+=4
        if fl&1: a1=s16(p);a2=s16(p+2);p+=4
        else: a1=struct.unpack('>b',d[p:p+1])[0];a2=struct.unpack('>b',d[p+1:p+2])[0];p+=2
        if fl&8: p+=2
        elif fl&0x40: p+=4
        elif fl&0x80: p+=8
        out+=contours(gi,dx+a1,dy+a2)
        if not fl&0x20: break
    return out
def path(cs, ox, base, scale):
    # TrueType quadratic contours to SVG path; y flipped
    P=lambda x,y:(ox+x*scale, base-y*scale)
    s=''
    for c in cs:
        pts=c; n=len(pts)
        # start at an on-curve point
        k=next((i for i in range(n) if pts[i][2]),None)
        if k is None:
            a,b=pts[0],pts[1]; start=((a[0]+b[0])/2,(a[1]+b[1])/2,1); pts=[start]+pts[1:]+[pts[0]]; k=0
        seq=pts[k:]+pts[:k]
        x,y=P(seq[0][0],seq[0][1]); s+='M%.1f %.1f'%(x,y)
        i=1; m=len(seq)
        while i<=m:
            cur=seq[i%m]
            if cur[2]:
                x,y=P(cur[0],cur[1]); s+='L%.1f %.1f'%(x,y); i+=1
            else:
                nxt=seq[(i+1)%m]
                if nxt[2]: end=nxt; i+=2
                else: end=((cur[0]+nxt[0])/2,(cur[1]+nxt[1])/2,1); i+=1
                cx,cy=P(cur[0],cur[1]); ex,ey=P(end[0],end[1]); s+='Q%.1f %.1f %.1f %.1f'%(cx,cy,ex,ey)
        s+='Z'
    return s
text=sys.argv[2]; size=float(sys.argv[3]); x0=float(sys.argv[4]); base=float(sys.argv[5]); track=float(sys.argv[6])
scale=size/upm; x=x0; out=''
for ch in text:
    g=cmapmap.get(ord(ch),0); out+=path(contours(g),x,base,scale); x+=adv(g)*scale+track*size
print(json.dumps({'d':out,'end':x-track*size,'upm':upm,'cap':cap,'capPx':cap*scale if cap else None}))
