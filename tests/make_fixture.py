"""Make small fake BTS-format month files so the pipeline and site can be tested offline."""
import calendar, csv, io, os, random, sys, zipfile
out = sys.argv[1]; os.makedirs(out, exist_ok=True)
HDR = ["Year","Month","DayofMonth","DayOfWeek","FlightDate","Marketing_Airline_Network","Operated_or_Branded_Code_Share_Partners",
 "IATA_Code_Marketing_Airline","Flight_Number_Marketing_Airline","Operating_Airline ","IATA_Code_Operating_Airline","Tail_Number",
 "Flight_Number_Operating_Airline","Origin","Dest","CRSDepTime","DepTime","CRSArrTime","ArrTime","ArrDelay","ArrDelayMinutes","ArrDel15",
 "Cancelled","CRSElapsedTime","Distance"]
# carrier, fn, operator, o, d, dep, arr, minutes, miles, weekdays(0=Mon), active months filter
F = [("AA","5250","OH","BWI","CLT","0600","0739",99,361,range(7),None),
     ("AA","5402","OH","CLT","DAB","0910","1058",108,421,range(7),None),
     ("AA","1874","AA","BWI","CLT","1530","1709",99,361,range(7),None),
     ("AA","5577","OH","CLT","DAB","1820","2005",105,421,[0,3,4,6],None),
     ("DL","1220","DL","BWI","ATL","0700","0911",131,577,range(7),None),
     ("DL","5011","9E","ATL","DAB","1015","1135",80,366,range(7),None),
     ("DL","2650","DL","ATL","DAB","1400","1522",82,366,range(6),None),
     ("WN","2181","WN","BWI","MCO","0645","0905",140,787,range(7),None),
     ("WN","3310","WN","BWI","MCO","1810","2030",140,787,[4,6],None),
     ("B6","1567","B6","BWI","MCO","1105","1330",145,787,range(7),lambda m:m in(11,12,1,2,3)),
     ("WN","1442","WN","MCO","BWI","1500","1720",140,787,range(7),None),
     ("AA","5403","OH","DAB","CLT","1140","1328",108,421,range(7),None),
     ("AA","2011","AA","CLT","BWI","1530","1706",96,361,range(7),None)]
months=[]; y,m=2026,8
for _ in range(14): months.append((y,m)); m-=1; y,m=(y-1,12) if m==0 else (y,m)
for y,m in months:
    buf=io.StringIO(); w=csv.writer(buf); w.writerow(HDR)
    for d in range(1,calendar.monthrange(y,m)[1]+1):
        wd=calendar.weekday(y,m,d)
        for c,fn,op,o,de,dep,arr,el,mi,wds,act in F:
            if wd not in wds or (act and not act(m)): continue
            cx=1 if random.random()<.02 else 0; late=0 if cx else int(random.random()<.2)
            w.writerow([y,m,d,wd+1,f"{y}-{m:02d}-{d:02d}",c,c if op==c else "CS",c,fn,op,op,"N1",fn,o,de,dep,"",arr,"",
                        "", 35 if late else 0, late, cx, el, mi])
    with zipfile.ZipFile(f"{out}/mkt_{y}_{m}.zip","w",zipfile.ZIP_DEFLATED) as z:
        z.writestr(f"On_Time_Marketing_{y}_{m}.csv", buf.getvalue())
print("fixture months", months[-1], "to", months[0])
