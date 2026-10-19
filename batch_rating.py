"""Bulk-load rating data once instead of making a query for every criterion."""
from datetime import date

def load_bundle(connection):
    tables = ('classes','categories','subcategories','class_subcategory_scores','class_category_scores','class_subcategory_events','uniform_checks')
    data={}
    with connection.cursor() as cursor:
        for table in tables:
            cursor.execute('SELECT * FROM '+table)
            data[table]=list(cursor.fetchall())
    data['categories']=sorted([r for r in data['categories'] if r['status']=='active'],key=lambda r:(r['sort_order'],r['id']))
    data['subcategories']=sorted([r for r in data['subcategories'] if r['status']=='active'],key=lambda r:(r['sort_order'],r['id']))
    return data

def uniform_summary(data,cls,formatter):
    checks=sorted([r for r in data['uniform_checks'] if r['class_id']==cls['id']],key=lambda r:(r['check_date'],r['id']),reverse=True)
    checks=[formatter(cls,r) for r in checks]
    latest=checks[0]['check_date'] if checks else None
    return dict(class_id=cls['id'],class_name=cls['name'],students_count=cls['students_count'],average_points=round(sum(r['points'] for r in checks)/len(checks),2) if checks else 0,checks_count=len(checks),is_checked_current_month=bool(latest and latest[:7]==date.today().isoformat()[:7]),latest_check_date=latest,checks=checks)

def scores(data,cls,formatter):
    uniform=uniform_summary(data,cls,formatter)
    result=[]
    for cat in data['categories']:
        subs=[]
        for sub in (s for s in data['subcategories'] if s['category_id']==cat['id']):
            events=sorted([e for e in data['class_subcategory_events'] if e['class_id']==cls['id'] and e['subcategory_id']==sub['id']],key=lambda e:(e['event_date'],e['id']),reverse=True)
            manual=next((r for r in data['class_subcategory_scores'] if r['class_id']==cls['id'] and r['subcategory_id']==sub['id']),{})
            is_uniform=sub.get('code')=='КР-08.01'
            raw=uniform['average_points'] if is_uniform else sum(float(e['points']) for e in events) if events else float(manual.get('points',0))
            item=dict(sub,points=round(min(raw,sub['max_points']),2),raw_points=round(raw,2),maxed=raw>sub['max_points'],events=[] if is_uniform else [dict(e,event_date=str(e['event_date']),created_at=str(e['created_at'])) for e in events],comment=manual.get('comment'),updated_at=str(manual['updated_at']) if manual.get('updated_at') else None)
            if is_uniform:item['uniform_summary']=uniform
            subs.append(item)
        manual=next((r for r in data['class_category_scores'] if r['class_id']==cls['id'] and r['category_id']==cat['id']),{})
        raw=sum(s['points'] for s in subs) if subs else float(manual.get('points',0))
        item=dict(cat,points=round(min(raw,cat['max_points']),2),raw_points=round(raw,2),maxed=raw>cat['max_points'],comment=manual.get('comment'),updated_at=str(manual['updated_at']) if manual.get('updated_at') else None,subcategories=subs)
        if any(s.get('code')=='КР-08.01' for s in subs):item['uniform_summary']=uniform
        result.append(item)
    return result

def ratings(connection,formatter,group_id=None):
    data=load_bundle(connection);result=[]
    for cls in sorted(data['classes'],key=lambda r:(r['grade'],r['name'])):
        if cls['status']!='active' or (group_id is not None and cls['group_id']!=group_id):continue
        cats=scores(data,cls,formatter);possible=sum(c['max_points'] for c in cats)
        result.append(dict(class_id=cls['id'],class_name=cls['name'],grade=cls['grade'],group_id=cls['group_id'],students_count=cls['students_count'],total=round(sum(c['points'] for c in cats)/possible*100,2) if possible else 0,categories=cats))
    return sorted(result,key=lambda r:r['total'],reverse=True)
