(module
 (type $0 (func (param i32) (result f64)))
 (type $1 (func))
 (type $2 (func (result i32)))
 (type $3 (func (param i32 i32) (result i32)))
 (type $4 (func (param f64 f64) (result f64)))
 (type $5 (func (param i32 i32) (result f64)))
 (type $6 (func (param i32 i32 f64)))
 (type $7 (func (param i32 i32 i32)))
 (type $8 (func (param i32 i32 i32 i32)))
 (type $9 (func (param i32)))
 (type $10 (func (param i32) (result i32)))
 (type $11 (func (param f64)))
 (type $12 (func (param f64 f64 f64 f64 f64 f64 f64 f64 f64 f64 f64)))
 (type $13 (func (param f64 f64 f64 f64) (result i32)))
 (import "env" "abort" (func $~lib/builtins/abort (param i32 i32 i32 i32)))
 (global $~lib/rt/stub/offset (mut i32) (i32.const 0))
 (global $src/fluid/as-src/sph/posX (mut i32) (i32.const 0))
 (global $src/fluid/as-src/sph/posY (mut i32) (i32.const 0))
 (global $src/fluid/as-src/sph/velX (mut i32) (i32.const 0))
 (global $src/fluid/as-src/sph/velY (mut i32) (i32.const 0))
 (global $src/fluid/as-src/sph/density (mut i32) (i32.const 0))
 (global $src/fluid/as-src/sph/pressure (mut i32) (i32.const 0))
 (global $src/fluid/as-src/sph/forceX (mut i32) (i32.const 0))
 (global $src/fluid/as-src/sph/forceY (mut i32) (i32.const 0))
 (global $src/fluid/as-src/sph/particleCount (mut i32) (i32.const 0))
 (global $src/fluid/as-src/sph/h (mut f64) (f64.const 1))
 (global $src/fluid/as-src/sph/restDensity (mut f64) (f64.const 1e3))
 (global $src/fluid/as-src/sph/gasConstant (mut f64) (f64.const 200))
 (global $src/fluid/as-src/sph/viscosityMu (mut f64) (f64.const 3.5))
 (global $src/fluid/as-src/sph/particleMass (mut f64) (f64.const 1))
 (global $src/fluid/as-src/sph/gravityY (mut f64) (f64.const -9.81))
 (global $src/fluid/as-src/sph/boundMinX (mut f64) (f64.const 0))
 (global $src/fluid/as-src/sph/boundMaxX (mut f64) (f64.const 20))
 (global $src/fluid/as-src/sph/boundMinY (mut f64) (f64.const 0))
 (global $src/fluid/as-src/sph/boundMaxY (mut f64) (f64.const 20))
 (global $src/fluid/as-src/sph/boundaryDamping (mut f64) (f64.const 0.5))
 (global $src/fluid/as-src/sph/poly6Coef (mut f64) (f64.const 0))
 (global $src/fluid/as-src/sph/spikyGradCoef (mut f64) (f64.const 0))
 (global $src/fluid/as-src/sph/viscLapCoef (mut f64) (f64.const 0))
 (global $src/fluid/as-src/sph/h2 (mut f64) (f64.const 0))
 (global $~lib/util/math/log_tail (mut f64) (f64.const 0))
 (global $src/fluid/as-src/sph/cellCount (mut i32) (i32.const 0))
 (global $src/fluid/as-src/sph/cellStart (mut i32) (i32.const 0))
 (global $src/fluid/as-src/sph/sortedIdx (mut i32) (i32.const 0))
 (global $src/fluid/as-src/sph/particleCell (mut i32) (i32.const 0))
 (global $src/fluid/as-src/sph/gridOriginX (mut f64) (f64.const 0))
 (global $src/fluid/as-src/sph/gridOriginY (mut f64) (f64.const 0))
 (global $~lib/rt/__rtti_base i32 (i32.const 7504))
 (memory $0 1)
 (data $0 (i32.const 1036) ",")
 (data $0.1 (i32.const 1048) "\02\00\00\00\1c\00\00\00I\00n\00v\00a\00l\00i\00d\00 \00l\00e\00n\00g\00t\00h")
 (data $1 (i32.const 1084) "<")
 (data $1.1 (i32.const 1096) "\02\00\00\00&\00\00\00~\00l\00i\00b\00/\00s\00t\00a\00t\00i\00c\00a\00r\00r\00a\00y\00.\00t\00s")
 (data $2 (i32.const 1148) "<")
 (data $2.1 (i32.const 1160) "\02\00\00\00(\00\00\00A\00l\00l\00o\00c\00a\00t\00i\00o\00n\00 \00t\00o\00o\00 \00l\00a\00r\00g\00e")
 (data $3 (i32.const 1212) "<")
 (data $3.1 (i32.const 1224) "\02\00\00\00\1e\00\00\00~\00l\00i\00b\00/\00r\00t\00/\00s\00t\00u\00b\00.\00t\00s")
 (data $4 (i32.const 1285) "\a0\f6?")
 (data $4.1 (i32.const 1297) "\c8\b9\f2\82,\d6\bf\80V7($\b4\fa<\00\00\00\00\00\80\f6?")
 (data $4.2 (i32.const 1329) "\08X\bf\bd\d1\d5\bf \f7\e0\d8\08\a5\1c\bd\00\00\00\00\00`\f6?")
 (data $4.3 (i32.const 1361) "XE\17wv\d5\bfmP\b6\d5\a4b#\bd\00\00\00\00\00@\f6?")
 (data $4.4 (i32.const 1393) "\f8-\87\ad\1a\d5\bf\d5g\b0\9e\e4\84\e6\bc\00\00\00\00\00 \f6?")
 (data $4.5 (i32.const 1425) "xw\95_\be\d4\bf\e0>)\93i\1b\04\bd\00\00\00\00\00\00\f6?")
 (data $4.6 (i32.const 1457) "`\1c\c2\8ba\d4\bf\cc\84LH/\d8\13=\00\00\00\00\00\e0\f5?")
 (data $4.7 (i32.const 1489) "\a8\86\860\04\d4\bf:\0b\82\ed\f3B\dc<\00\00\00\00\00\c0\f5?")
 (data $4.8 (i32.const 1521) "HiUL\a6\d3\bf`\94Q\86\c6\b1 =\00\00\00\00\00\a0\f5?")
 (data $4.9 (i32.const 1553) "\80\98\9a\ddG\d3\bf\92\80\c5\d4MY%=\00\00\00\00\00\80\f5?")
 (data $4.10 (i32.const 1585) " \e1\ba\e2\e8\d2\bf\d8+\b7\99\1e{&=\00\00\00\00\00`\f5?")
 (data $4.11 (i32.const 1617) "\88\de\13Z\89\d2\bf?\b0\cf\b6\14\ca\15=\00\00\00\00\00`\f5?")
 (data $4.12 (i32.const 1649) "\88\de\13Z\89\d2\bf?\b0\cf\b6\14\ca\15=\00\00\00\00\00@\f5?")
 (data $4.13 (i32.const 1681) "x\cf\fbA)\d2\bfv\daS($Z\16\bd\00\00\00\00\00 \f5?")
 (data $4.14 (i32.const 1713) "\98i\c1\98\c8\d1\bf\04T\e7h\bc\af\1f\bd\00\00\00\00\00\00\f5?")
 (data $4.15 (i32.const 1745) "\a8\ab\ab\\g\d1\bf\f0\a8\823\c6\1f\1f=\00\00\00\00\00\e0\f4?")
 (data $4.16 (i32.const 1777) "H\ae\f9\8b\05\d1\bffZ\05\fd\c4\a8&\bd\00\00\00\00\00\c0\f4?")
 (data $4.17 (i32.const 1809) "\90s\e2$\a3\d0\bf\0e\03\f4~\eek\0c\bd\00\00\00\00\00\a0\f4?")
 (data $4.18 (i32.const 1841) "\d0\b4\94%@\d0\bf\7f-\f4\9e\b86\f0\bc\00\00\00\00\00\a0\f4?")
 (data $4.19 (i32.const 1873) "\d0\b4\94%@\d0\bf\7f-\f4\9e\b86\f0\bc\00\00\00\00\00\80\f4?")
 (data $4.20 (i32.const 1905) "@^m\18\b9\cf\bf\87<\99\ab*W\r=\00\00\00\00\00`\f4?")
 (data $4.21 (i32.const 1937) "`\dc\cb\ad\f0\ce\bf$\af\86\9c\b7&+=\00\00\00\00\00@\f4?")
 (data $4.22 (i32.const 1969) "\f0*n\07\'\ce\bf\10\ff?TO/\17\bd\00\00\00\00\00 \f4?")
 (data $4.23 (i32.const 2001) "\c0Ok!\\\cd\bf\1bh\ca\bb\91\ba!=\00\00\00\00\00\00\f4?")
 (data $4.24 (i32.const 2033) "\a0\9a\c7\f7\8f\cc\bf4\84\9fhOy\'=\00\00\00\00\00\00\f4?")
 (data $4.25 (i32.const 2065) "\a0\9a\c7\f7\8f\cc\bf4\84\9fhOy\'=\00\00\00\00\00\e0\f3?")
 (data $4.26 (i32.const 2097) "\90-t\86\c2\cb\bf\8f\b7\8b1\b0N\19=\00\00\00\00\00\c0\f3?")
 (data $4.27 (i32.const 2129) "\c0\80N\c9\f3\ca\bff\90\cd?cN\ba<\00\00\00\00\00\a0\f3?")
 (data $4.28 (i32.const 2161) "\b0\e2\1f\bc#\ca\bf\ea\c1F\dcd\8c%\bd\00\00\00\00\00\a0\f3?")
 (data $4.29 (i32.const 2193) "\b0\e2\1f\bc#\ca\bf\ea\c1F\dcd\8c%\bd\00\00\00\00\00\80\f3?")
 (data $4.30 (i32.const 2225) "P\f4\9cZR\c9\bf\e3\d4\c1\04\d9\d1*\bd\00\00\00\00\00`\f3?")
 (data $4.31 (i32.const 2257) "\d0 e\a0\7f\c8\bf\t\fa\db\7f\bf\bd+=\00\00\00\00\00@\f3?")
 (data $4.32 (i32.const 2289) "\e0\10\02\89\ab\c7\bfXJSr\90\db+=\00\00\00\00\00@\f3?")
 (data $4.33 (i32.const 2321) "\e0\10\02\89\ab\c7\bfXJSr\90\db+=\00\00\00\00\00 \f3?")
 (data $4.34 (i32.const 2353) "\d0\19\e7\0f\d6\c6\bff\e2\b2\a3j\e4\10\bd\00\00\00\00\00\00\f3?")
 (data $4.35 (i32.const 2385) "\90\a7p0\ff\c5\bf9P\10\9fC\9e\1e\bd\00\00\00\00\00\00\f3?")
 (data $4.36 (i32.const 2417) "\90\a7p0\ff\c5\bf9P\10\9fC\9e\1e\bd\00\00\00\00\00\e0\f2?")
 (data $4.37 (i32.const 2449) "\b0\a1\e3\e5&\c5\bf\8f[\07\90\8b\de \bd\00\00\00\00\00\c0\f2?")
 (data $4.38 (i32.const 2481) "\80\cbl+M\c4\bf<x5a\c1\0c\17=\00\00\00\00\00\c0\f2?")
 (data $4.39 (i32.const 2513) "\80\cbl+M\c4\bf<x5a\c1\0c\17=\00\00\00\00\00\a0\f2?")
 (data $4.40 (i32.const 2545) "\90\1e \fcq\c3\bf:T\'M\86x\f1<\00\00\00\00\00\80\f2?")
 (data $4.41 (i32.const 2577) "\f0\1f\f8R\95\c2\bf\08\c4q\170\8d$\bd\00\00\00\00\00`\f2?")
 (data $4.42 (i32.const 2609) "`/\d5*\b7\c1\bf\96\a3\11\18\a4\80.\bd\00\00\00\00\00`\f2?")
 (data $4.43 (i32.const 2641) "`/\d5*\b7\c1\bf\96\a3\11\18\a4\80.\bd\00\00\00\00\00@\f2?")
 (data $4.44 (i32.const 2673) "\90\d0|~\d7\c0\bf\f4[\e8\88\96i\n=\00\00\00\00\00@\f2?")
 (data $4.45 (i32.const 2705) "\90\d0|~\d7\c0\bf\f4[\e8\88\96i\n=\00\00\00\00\00 \f2?")
 (data $4.46 (i32.const 2737) "\e0\db1\91\ec\bf\bf\f23\a3\\Tu%\bd\00\00\00\00\00\00\f2?")
 (data $4.47 (i32.const 2770) "+n\07\'\be\bf<\00\f0*,4*=\00\00\00\00\00\00\f2?")
 (data $4.48 (i32.const 2802) "+n\07\'\be\bf<\00\f0*,4*=\00\00\00\00\00\e0\f1?")
 (data $4.49 (i32.const 2833) "\c0[\8fT^\bc\bf\06\be_XW\0c\1d\bd\00\00\00\00\00\c0\f1?")
 (data $4.50 (i32.const 2865) "\e0J:m\92\ba\bf\c8\aa[\e859%=\00\00\00\00\00\c0\f1?")
 (data $4.51 (i32.const 2897) "\e0J:m\92\ba\bf\c8\aa[\e859%=\00\00\00\00\00\a0\f1?")
 (data $4.52 (i32.const 2929) "\a01\d6E\c3\b8\bfhV/M)|\13=\00\00\00\00\00\a0\f1?")
 (data $4.53 (i32.const 2961) "\a01\d6E\c3\b8\bfhV/M)|\13=\00\00\00\00\00\80\f1?")
 (data $4.54 (i32.const 2993) "`\e5\8a\d2\f0\b6\bf\das3\c97\97&\bd\00\00\00\00\00`\f1?")
 (data $4.55 (i32.const 3025) " \06?\07\1b\b5\bfW^\c6a[\02\1f=\00\00\00\00\00`\f1?")
 (data $4.56 (i32.const 3057) " \06?\07\1b\b5\bfW^\c6a[\02\1f=\00\00\00\00\00@\f1?")
 (data $4.57 (i32.const 3089) "\e0\1b\96\d7A\b3\bf\df\13\f9\cc\da^,=\00\00\00\00\00@\f1?")
 (data $4.58 (i32.const 3121) "\e0\1b\96\d7A\b3\bf\df\13\f9\cc\da^,=\00\00\00\00\00 \f1?")
 (data $4.59 (i32.const 3153) "\80\a3\ee6e\b1\bf\t\a3\8fv^|\14=\00\00\00\00\00\00\f1?")
 (data $4.60 (i32.const 3185) "\80\11\c00\n\af\bf\91\8e6\83\9eY-=\00\00\00\00\00\00\f1?")
 (data $4.61 (i32.const 3217) "\80\11\c00\n\af\bf\91\8e6\83\9eY-=\00\00\00\00\00\e0\f0?")
 (data $4.62 (i32.const 3249) "\80\19q\ddB\ab\bfLp\d6\e5z\82\1c=\00\00\00\00\00\e0\f0?")
 (data $4.63 (i32.const 3281) "\80\19q\ddB\ab\bfLp\d6\e5z\82\1c=\00\00\00\00\00\c0\f0?")
 (data $4.64 (i32.const 3313) "\c02\f6Xt\a7\bf\ee\a1\f24F\fc,\bd\00\00\00\00\00\c0\f0?")
 (data $4.65 (i32.const 3345) "\c02\f6Xt\a7\bf\ee\a1\f24F\fc,\bd\00\00\00\00\00\a0\f0?")
 (data $4.66 (i32.const 3377) "\c0\fe\b9\87\9e\a3\bf\aa\fe&\f5\b7\02\f5<\00\00\00\00\00\a0\f0?")
 (data $4.67 (i32.const 3409) "\c0\fe\b9\87\9e\a3\bf\aa\fe&\f5\b7\02\f5<\00\00\00\00\00\80\f0?")
 (data $4.68 (i32.const 3442) "x\0e\9b\82\9f\bf\e4\t~|&\80)\bd\00\00\00\00\00\80\f0?")
 (data $4.69 (i32.const 3474) "x\0e\9b\82\9f\bf\e4\t~|&\80)\bd\00\00\00\00\00`\f0?")
 (data $4.70 (i32.const 3505) "\80\d5\07\1b\b9\97\bf9\a6\fa\93T\8d(\bd\00\00\00\00\00@\f0?")
 (data $4.71 (i32.const 3538) "\fc\b0\a8\c0\8f\bf\9c\a6\d3\f6|\1e\df\bc\00\00\00\00\00@\f0?")
 (data $4.72 (i32.const 3570) "\fc\b0\a8\c0\8f\bf\9c\a6\d3\f6|\1e\df\bc\00\00\00\00\00 \f0?")
 (data $4.73 (i32.const 3602) "\10k*\e0\7f\bf\e4@\da\r?\e2\19\bd\00\00\00\00\00 \f0?")
 (data $4.74 (i32.const 3634) "\10k*\e0\7f\bf\e4@\da\r?\e2\19\bd\00\00\00\00\00\00\f0?")
 (data $4.75 (i32.const 3686) "\f0?")
 (data $4.76 (i32.const 3717) "\c0\ef?")
 (data $4.77 (i32.const 3730) "\89u\15\10\80?\e8+\9d\99k\c7\10\bd\00\00\00\00\00\80\ef?")
 (data $4.78 (i32.const 3761) "\80\93XV \90?\d2\f7\e2\06[\dc#\bd\00\00\00\00\00@\ef?")
 (data $4.79 (i32.const 3794) "\c9(%I\98?4\0cZ2\ba\a0*\bd\00\00\00\00\00\00\ef?")
 (data $4.80 (i32.const 3825) "@\e7\89]A\a0?S\d7\f1\\\c0\11\01=\00\00\00\00\00\c0\ee?")
 (data $4.81 (i32.const 3858) ".\d4\aef\a4?(\fd\bdus\16,\bd\00\00\00\00\00\80\ee?")
 (data $4.82 (i32.const 3889) "\c0\9f\14\aa\94\a8?}&Z\d0\95y\19\bd\00\00\00\00\00@\ee?")
 (data $4.83 (i32.const 3921) "\c0\dd\cds\cb\ac?\07(\d8G\f2h\1a\bd\00\00\00\00\00 \ee?")
 (data $4.84 (i32.const 3953) "\c0\06\c01\ea\ae?{;\c9O>\11\0e\bd\00\00\00\00\00\e0\ed?")
 (data $4.85 (i32.const 3985) "`F\d1;\97\b1?\9b\9e\rV]2%\bd\00\00\00\00\00\a0\ed?")
 (data $4.86 (i32.const 4017) "\e0\d1\a7\f5\bd\b3?\d7N\db\a5^\c8,=\00\00\00\00\00`\ed?")
 (data $4.87 (i32.const 4049) "\a0\97MZ\e9\b5?\1e\1d]<\06i,\bd\00\00\00\00\00@\ed?")
 (data $4.88 (i32.const 4081) "\c0\ea\n\d3\00\b7?2\ed\9d\a9\8d\1e\ec<\00\00\00\00\00\00\ed?")
 (data $4.89 (i32.const 4113) "@Y]^3\b9?\daG\bd:\\\11#=\00\00\00\00\00\c0\ec?")
 (data $4.90 (i32.const 4145) "`\ad\8d\c8j\bb?\e5h\f7+\80\90\13\bd\00\00\00\00\00\a0\ec?")
 (data $4.91 (i32.const 4177) "@\bc\01X\88\bc?\d3\acZ\c6\d1F&=\00\00\00\00\00`\ec?")
 (data $4.92 (i32.const 4209) " \n\839\c7\be?\e0E\e6\afh\c0-\bd\00\00\00\00\00@\ec?")
 (data $4.93 (i32.const 4241) "\e0\db9\91\e8\bf?\fd\n\a1O\d64%\bd\00\00\00\00\00\00\ec?")
 (data $4.94 (i32.const 4273) "\e0\'\82\8e\17\c1?\f2\07-\cex\ef!=\00\00\00\00\00\e0\eb?")
 (data $4.95 (i32.const 4305) "\f0#~+\aa\c1?4\998D\8e\a7,=\00\00\00\00\00\a0\eb?")
 (data $4.96 (i32.const 4337) "\80\86\0ca\d1\c2?\a1\b4\81\cbl\9d\03=\00\00\00\00\00\80\eb?")
 (data $4.97 (i32.const 4369) "\90\15\b0\fce\c3?\89rK#\a8/\c6<\00\00\00\00\00@\eb?")
 (data $4.98 (i32.const 4401) "\b03\83=\91\c4?x\b6\fdTy\83%=\00\00\00\00\00 \eb?")
 (data $4.99 (i32.const 4433) "\b0\a1\e4\e5\'\c5?\c7}i\e5\e83&=\00\00\00\00\00\e0\ea?")
 (data $4.100 (i32.const 4465) "\10\8c\beNW\c6?x.<,\8b\cf\19=\00\00\00\00\00\c0\ea?")
 (data $4.101 (i32.const 4497) "pu\8b\12\f0\c6?\e1!\9c\e5\8d\11%\bd\00\00\00\00\00\a0\ea?")
 (data $4.102 (i32.const 4529) "PD\85\8d\89\c7?\05C\91p\10f\1c\bd\00\00\00\00\00`\ea?")
 (data $4.103 (i32.const 4562) "9\eb\af\be\c8?\d1,\e9\aaT=\07\bd\00\00\00\00\00@\ea?")
 (data $4.104 (i32.const 4594) "\f7\dcZZ\c9?o\ff\a0X(\f2\07=\00\00\00\00\00\00\ea?")
 (data $4.105 (i32.const 4625) "\e0\8a<\ed\93\ca?i!VPCr(\bd\00\00\00\00\00\e0\e9?")
 (data $4.106 (i32.const 4657) "\d0[W\d81\cb?\aa\e1\acN\8d5\0c\bd\00\00\00\00\00\c0\e9?")
 (data $4.107 (i32.const 4689) "\e0;8\87\d0\cb?\b6\12TY\c4K-\bd\00\00\00\00\00\a0\e9?")
 (data $4.108 (i32.const 4721) "\10\f0\c6\fbo\cc?\d2+\96\c5r\ec\f1\bc\00\00\00\00\00`\e9?")
 (data $4.109 (i32.const 4753) "\90\d4\b0=\b1\cd?5\b0\15\f7*\ff*\bd\00\00\00\00\00@\e9?")
 (data $4.110 (i32.const 4785) "\10\e7\ff\0eS\ce?0\f4A`\'\12\c2<\00\00\00\00\00 \e9?")
 (data $4.111 (i32.const 4818) "\dd\e4\ad\f5\ce?\11\8e\bbe\15!\ca\bc\00\00\00\00\00\00\e9?")
 (data $4.112 (i32.const 4849) "\b0\b3l\1c\99\cf?0\df\0c\ca\ec\cb\1b=\00\00\00\00\00\c0\e8?")
 (data $4.113 (i32.const 4881) "XM`8q\d0?\91N\ed\16\db\9c\f8<\00\00\00\00\00\a0\e8?")
 (data $4.114 (i32.const 4913) "`ag-\c4\d0?\e9\ea<\16\8b\18\'=\00\00\00\00\00\80\e8?")
 (data $4.115 (i32.const 4945) "\e8\'\82\8e\17\d1?\1c\f0\a5c\0e!,\bd\00\00\00\00\00`\e8?")
 (data $4.116 (i32.const 4977) "\f8\ac\cb\\k\d1?\81\16\a5\f7\cd\9a+=\00\00\00\00\00@\e8?")
 (data $4.117 (i32.const 5009) "hZc\99\bf\d1?\b7\bdGQ\ed\a6,=\00\00\00\00\00 \e8?")
 (data $4.118 (i32.const 5041) "\b8\0emE\14\d2?\ea\baF\ba\de\87\n=\00\00\00\00\00\e0\e7?")
 (data $4.119 (i32.const 5073) "\90\dc|\f0\be\d2?\f4\04PJ\fa\9c*=\00\00\00\00\00\c0\e7?")
 (data $4.120 (i32.const 5105) "`\d3\e1\f1\14\d3?\b8<!\d3z\e2(\bd\00\00\00\00\00\a0\e7?")
 (data $4.121 (i32.const 5137) "\10\bevgk\d3?\c8w\f1\b0\cdn\11=\00\00\00\00\00\80\e7?")
 (data $4.122 (i32.const 5169) "03wR\c2\d3?\\\bd\06\b6T;\18=\00\00\00\00\00`\e7?")
 (data $4.123 (i32.const 5201) "\e8\d5#\b4\19\d4?\9d\e0\90\ec6\e4\08=\00\00\00\00\00@\e7?")
 (data $4.124 (i32.const 5233) "\c8q\c2\8dq\d4?u\d6g\t\ce\'/\bd\00\00\00\00\00 \e7?")
 (data $4.125 (i32.const 5265) "0\17\9e\e0\c9\d4?\a4\d8\n\1b\89 .\bd\00\00\00\00\00\00\e7?")
 (data $4.126 (i32.const 5297) "\a08\07\ae\"\d5?Y\c7d\81p\be.=\00\00\00\00\00\e0\e6?")
 (data $4.127 (i32.const 5329) "\d0\c8S\f7{\d5?\ef@]\ee\ed\ad\1f=\00\00\00\00\00\c0\e6?")
 (data $4.128 (i32.const 5361) "`Y\df\bd\d5\d5?\dce\a4\08*\0b\n\bd")
 (data $5 (i32.const 5390) "\f0?n\bf\88\1aO;\9b<53\fb\a9=\f6\ef?]\dc\d8\9c\13`q\bca\80w>\9a\ec\ef?\d1f\87\10z^\90\bc\85\7fn\e8\15\e3\ef?\13\f6g5R\d2\8c<t\85\15\d3\b0\d9\ef?\fa\8e\f9#\80\ce\8b\bc\de\f6\dd)k\d0\ef?a\c8\e6aN\f7`<\c8\9bu\18E\c7\ef?\99\d33[\e4\a3\90<\83\f3\c6\ca>\be\ef?m{\83]\a6\9a\97<\0f\89\f9lX\b5\ef?\fc\ef\fd\92\1a\b5\8e<\f7Gr+\92\ac\ef?\d1\9c/p=\be><\a2\d1\d32\ec\a3\ef?\0bn\90\894\03j\bc\1b\d3\fe\aff\9b\ef?\0e\bd/*RV\95\bcQ[\12\d0\01\93\ef?U\eaN\8c\ef\80P\bc\cc1l\c0\bd\8a\ef?\16\f4\d5\b9#\c9\91\bc\e0-\a9\ae\9a\82\ef?\afU\\\e9\e3\d3\80<Q\8e\a5\c8\98z\ef?H\93\a5\ea\15\1b\80\bc{Q}<\b8r\ef?=2\deU\f0\1f\8f\bc\ea\8d\8c8\f9j\ef?\bfS\13?\8c\89\8b<u\cbo\eb[c\ef?&\eb\11v\9c\d9\96\bc\d4\\\04\84\e0[\ef?`/:>\f7\ec\9a<\aa\b9h1\87T\ef?\9d8\86\cb\82\e7\8f\bc\1d\d9\fc\"PM\ef?\8d\c3\a6DAo\8a<\d6\8cb\88;F\ef?}\04\e4\b0\05z\80<\96\dc}\91I?\ef?\94\a8\a8\e3\fd\8e\96<8bunz8\ef?}Ht\f2\18^\87<?\a6\b2O\ce1\ef?\f2\e7\1f\98+G\80<\dd|\e2eE+\ef?^\08q?{\b8\96\bc\81c\f5\e1\df$\ef?1\ab\tm\e1\f7\82<\e1\de\1f\f5\9d\1e\ef?\fa\bfo\1a\9b!=\bc\90\d9\da\d0\7f\18\ef?\b4\n\0cr\827\8b<\0b\03\e4\a6\85\12\ef?\8f\cb\ce\89\92\14n<V/>\a9\af\0c\ef?\b6\ab\b0MuM\83<\15\b71\n\fe\06\ef?Lt\ac\e2\01B\86<1\d8L\fcp\01\ef?J\f8\d3]9\dd\8f<\ff\16d\b2\08\fc\ee?\04[\8e;\80\a3\86\bc\f1\9f\92_\c5\f6\ee?hPK\cc\edJ\92\bc\cb\a9:7\a7\f1\ee?\8e-Q\1b\f8\07\99\bcf\d8\05m\ae\ec\ee?\d26\94>\e8\d1q\bc\f7\9f\e54\db\e7\ee?\15\1b\ce\b3\19\19\99\bc\e5\a8\13\c3-\e3\ee?mL*\a7H\9f\85<\"4\12L\a6\de\ee?\8ai(z`\12\93\bc\1c\80\ac\04E\da\ee?[\89\17H\8f\a7X\bc*.\f7!\n\d6\ee?\1b\9aIg\9b,|\bc\97\a8P\d9\f5\d1\ee?\11\ac\c2`\edcC<-\89a`\08\ce\ee?\efd\06;\tf\96<W\00\1d\edA\ca\ee?y\03\a1\da\e1\ccn<\d0<\c1\b5\a2\c6\ee?0\12\0f?\8e\ff\93<\de\d3\d7\f0*\c3\ee?\b0\afz\bb\ce\90v<\'*6\d5\da\bf\ee?w\e0T\eb\bd\1d\93<\r\dd\fd\99\b2\bc\ee?\8e\a3q\004\94\8f\bc\a7,\9dv\b2\b9\ee?I\a3\93\dc\cc\de\87\bcBf\cf\a2\da\b6\ee?_8\0f\bd\c6\dex\bc\82O\9dV+\b4\ee?\f6\\{\ecF\12\86\bc\0f\92]\ca\a4\b1\ee?\8e\d7\fd\18\055\93<\da\'\b56G\af\ee?\05\9b\8a/\b7\98{<\fd\c7\97\d4\12\ad\ee?\tT\1c\e2\e1c\90<)TH\dd\07\ab\ee?\ea\c6\19P\85\c74<\b7FY\8a&\a9\ee?5\c0d+\e62\94<H!\ad\15o\a7\ee?\9fv\99aJ\e4\8c\bc\t\dcv\b9\e1\a5\ee?\a8M\ef;\c53\8c\bc\85U:\b0~\a4\ee?\ae\e9+\89xS\84\bc \c3\cc4F\a3\ee?XXVx\dd\ce\93\bc%\"U\828\a2\ee?d\19~\80\aa\10W<s\a9L\d4U\a1\ee?(\"^\bf\ef\b3\93\bc\cd;\7ff\9e\a0\ee?\82\b94\87\ad\12j\bc\bf\da\0bu\12\a0\ee?\ee\a9m\b8\efgc\bc/\1ae<\b2\9f\ee?Q\88\e0T=\dc\80\bc\84\94Q\f9}\9f\ee?\cf>Z~d\1fx\bct_\ec\e8u\9f\ee?\b0}\8b\c0J\ee\86\bct\81\a5H\9a\9f\ee?\8a\e6U\1e2\19\86\bc\c9gBV\eb\9f\ee?\d3\d4\t^\cb\9c\90<?]\deOi\a0\ee?\1d\a5M\b9\dc2{\bc\87\01\ebs\14\a1\ee?k\c0gT\fd\ec\94<2\c10\01\ed\a1\ee?Ul\d6\ab\e1\ebe<bN\cf6\f3\a2\ee?B\cf\b3/\c5\a1\88\bc\12\1a>T\'\a4\ee?47;\f1\b6i\93\bc\13\ceL\99\89\a5\ee?\1e\ff\19:\84^\80\bc\ad\c7#F\1a\a7\ee?nWr\d8P\d4\94\bc\ed\92D\9b\d9\a8\ee?\00\8a\0e[g\ad\90<\99f\8a\d9\c7\aa\ee?\b4\ea\f0\c1/\b7\8d<\db\a0*B\e5\ac\ee?\ff\e7\c5\9c`\b6e\bc\8cD\b5\162\af\ee?D_\f3Y\83\f6{<6w\15\99\ae\b1\ee?\83=\1e\a7\1f\t\93\bc\c6\ff\91\0b[\b4\ee?)\1el\8b\b8\a9]\bc\e5\c5\cd\b07\b7\ee?Y\b9\90|\f9#l\bc\0fR\c8\cbD\ba\ee?\aa\f9\f4\"CC\92\bcPN\de\9f\82\bd\ee?K\8ef\d7l\ca\85\bc\ba\07\cap\f1\c0\ee?\'\ce\91+\fc\afq<\90\f0\a3\82\91\c4\ee?\bbs\n\e15\d2m<##\e3\19c\c8\ee?c\"b\"\04\c5\87\bce\e5]{f\cc\ee?\d51\e2\e3\86\1c\8b<3-J\ec\9b\d0\ee?\15\bb\bc\d3\d1\bb\91\bc]%>\b2\03\d5\ee?\d21\ee\9c1\cc\90<X\b30\13\9e\d9\ee?\b3Zsn\84i\84<\bf\fdyUk\de\ee?\b4\9d\8e\97\cd\df\82\bcz\f3\d3\bfk\e3\ee?\873\cb\92w\1a\8c<\ad\d3Z\99\9f\e8\ee?\fa\d9\d1J\8f{\90\bcf\b6\8d)\07\ee\ee?\ba\ae\dcV\d9\c3U\bc\fb\15O\b8\a2\f3\ee?@\f6\a6=\0e\a4\90\bc:Y\e5\8dr\f9\ee?4\93\ad8\f4\d6h\bcG^\fb\f2v\ff\ee?5\8aXk\e2\ee\91\bcJ\06\a10\b0\05\ef?\cd\dd_\n\d7\fft<\d2\c1K\90\1e\0c\ef?\ac\98\92\fa\fb\bd\91\bc\t\1e\d7[\c2\12\ef?\b3\0c\af0\aens<\9cR\85\dd\9b\19\ef?\94\fd\9f\\2\e3\8e<z\d0\ff_\ab \ef?\acY\t\d1\8f\e0\84<K\d1W.\f1\'\ef?g\1aN8\af\cdc<\b5\e7\06\94m/\ef?h\19\92l,kg<i\90\ef\dc 7\ef?\d2\b5\cc\83\18\8a\80\bc\fa\c3]U\0b?\ef?o\fa\ff?]\ad\8f\bc|\89\07J-G\ef?I\a9u8\ae\r\90\bc\f2\89\r\08\87O\ef?\a7\07=\a6\85\a3t<\87\a4\fb\dc\18X\ef?\0f\"@ \9e\91\82\bc\98\83\c9\16\e3`\ef?\ac\92\c1\d5PZ\8e<\852\db\03\e6i\ef?Kk\01\acY:\84<`\b4\01\f3!s\ef?\1f>\b4\07!\d5\82\bc_\9b{3\97|\ef?\c9\rG;\b9*\89\bc)\a1\f5\14F\86\ef?\d3\88:`\04\b6t<\f6?\8b\e7.\90\ef?qr\9dQ\ec\c5\83<\83L\c7\fbQ\9a\ef?\f0\91\d3\8f\12\f7\8f\bc\da\90\a4\a2\af\a4\ef?}t#\e2\98\ae\8d\bc\f1g\8e-H\af\ef?\08 \aaA\bc\c3\8e<\'Za\ee\1b\ba\ef?2\eb\a9\c3\94+\84<\97\bak7+\c5\ef?\ee\85\d11\a9d\8a<@En[v\d0\ef?\ed\e3;\e4\ba7\8e\bc\14\be\9c\ad\fd\db\ef?\9d\cd\91M;\89w<\d8\90\9e\81\c1\e7\ef?\89\cc`A\c1\05S<\f1q\8f+\c2\f3\ef?")
 (data $6 (i32.const 7436) "<")
 (data $6.1 (i32.const 7448) "\02\00\00\00$\00\00\00I\00n\00d\00e\00x\00 \00o\00u\00t\00 \00o\00f\00 \00r\00a\00n\00g\00e")
 (data $7 (i32.const 7504) "\06\00\00\00 \00\00\00 \00\00\00 \00\00\00\00\00\00\00$\1a\00\00$\t")
 (export "configure" (func $src/fluid/as-src/sph/configure))
 (export "reset" (func $src/fluid/as-src/sph/reset))
 (export "estimateParticleMass" (func $src/fluid/as-src/sph/estimateParticleMass))
 (export "addParticle" (func $src/fluid/as-src/sph/addParticle))
 (export "getParticleCount" (func $src/fluid/as-src/sph/getParticleCount))
 (export "step" (func $src/fluid/as-src/sph/step))
 (export "getPosX" (func $src/fluid/as-src/sph/getPosX))
 (export "getPosY" (func $src/fluid/as-src/sph/getPosY))
 (export "getVelX" (func $src/fluid/as-src/sph/getVelX))
 (export "getVelY" (func $src/fluid/as-src/sph/getVelY))
 (export "getDensity" (func $src/fluid/as-src/sph/getDensity))
 (export "getPressure" (func $src/fluid/as-src/sph/getPressure))
 (export "posXPtr" (func $src/fluid/as-src/sph/posXPtr))
 (export "posYPtr" (func $src/fluid/as-src/sph/posYPtr))
 (export "__new" (func $~lib/rt/stub/__new))
 (export "__pin" (func $~lib/rt/stub/__pin))
 (export "__unpin" (func $~lib/rt/stub/__unpin))
 (export "__collect" (func $~lib/rt/stub/__collect))
 (export "__rtti_base" (global $~lib/rt/__rtti_base))
 (export "memory" (memory $0))
 (start $~start)
 (func $~lib/staticarray/StaticArray<f64>#__get (param $0 i32) (param $1 i32) (result f64)
  local.get $1
  local.get $0
  i32.const 20
  i32.sub
  i32.load offset=16
  i32.const 3
  i32.shr_u
  i32.ge_u
  if
   i32.const 7456
   i32.const 1104
   i32.const 78
   i32.const 41
   call $~lib/builtins/abort
   unreachable
  end
  local.get $0
  local.get $1
  i32.const 3
  i32.shl
  i32.add
  f64.load
 )
 (func $~lib/staticarray/StaticArray<f64>#__set (param $0 i32) (param $1 i32) (param $2 f64)
  local.get $1
  local.get $0
  i32.const 20
  i32.sub
  i32.load offset=16
  i32.const 3
  i32.shr_u
  i32.ge_u
  if
   i32.const 7456
   i32.const 1104
   i32.const 93
   i32.const 41
   call $~lib/builtins/abort
   unreachable
  end
  local.get $0
  local.get $1
  i32.const 3
  i32.shl
  i32.add
  local.get $2
  f64.store
 )
 (func $~lib/rt/stub/__new (param $0 i32) (param $1 i32) (result i32)
  (local $2 i32)
  (local $3 i32)
  (local $4 i32)
  (local $5 i32)
  (local $6 i32)
  local.get $0
  i32.const 1073741804
  i32.gt_u
  if
   i32.const 1168
   i32.const 1232
   i32.const 86
   i32.const 30
   call $~lib/builtins/abort
   unreachable
  end
  local.get $0
  i32.const 16
  i32.add
  local.tee $3
  i32.const 1073741820
  i32.gt_u
  if
   i32.const 1168
   i32.const 1232
   i32.const 33
   i32.const 29
   call $~lib/builtins/abort
   unreachable
  end
  global.get $~lib/rt/stub/offset
  i32.const 4
  i32.add
  local.tee $2
  local.get $3
  i32.const 19
  i32.add
  i32.const -16
  i32.and
  i32.const 4
  i32.sub
  local.tee $3
  i32.add
  local.tee $4
  memory.size
  local.tee $5
  i32.const 16
  i32.shl
  i32.const 15
  i32.add
  i32.const -16
  i32.and
  local.tee $6
  i32.gt_u
  if
   local.get $5
   local.get $4
   local.get $6
   i32.sub
   i32.const 65535
   i32.add
   i32.const -65536
   i32.and
   i32.const 16
   i32.shr_u
   local.tee $6
   local.get $5
   local.get $6
   i32.gt_s
   select
   memory.grow
   i32.const 0
   i32.lt_s
   if
    local.get $6
    memory.grow
    i32.const 0
    i32.lt_s
    if
     unreachable
    end
   end
  end
  global.get $~lib/rt/stub/offset
  local.get $4
  global.set $~lib/rt/stub/offset
  local.get $3
  i32.store
  local.get $2
  i32.const 4
  i32.sub
  local.tee $3
  i32.const 0
  i32.store offset=4
  local.get $3
  i32.const 0
  i32.store offset=8
  local.get $3
  local.get $1
  i32.store offset=12
  local.get $3
  local.get $0
  i32.store offset=16
  local.get $2
  i32.const 16
  i32.add
 )
 (func $~lib/staticarray/StaticArray<i32>#__get (param $0 i32) (param $1 i32) (result i32)
  local.get $1
  local.get $0
  i32.const 20
  i32.sub
  i32.load offset=16
  i32.const 2
  i32.shr_u
  i32.ge_u
  if
   i32.const 7456
   i32.const 1104
   i32.const 78
   i32.const 41
   call $~lib/builtins/abort
   unreachable
  end
  local.get $0
  local.get $1
  i32.const 2
  i32.shl
  i32.add
  i32.load
 )
 (func $~lib/staticarray/StaticArray<i32>#__set (param $0 i32) (param $1 i32) (param $2 i32)
  local.get $1
  local.get $0
  i32.const 20
  i32.sub
  i32.load offset=16
  i32.const 2
  i32.shr_u
  i32.ge_u
  if
   i32.const 7456
   i32.const 1104
   i32.const 93
   i32.const 41
   call $~lib/builtins/abort
   unreachable
  end
  local.get $0
  local.get $1
  i32.const 2
  i32.shl
  i32.add
  local.get $2
  i32.store
 )
 (func $~lib/math/NativeMath.pow (param $0 f64) (param $1 f64) (result f64)
  (local $2 i64)
  (local $3 i32)
  (local $4 i32)
  (local $5 i64)
  (local $6 i64)
  (local $7 f64)
  (local $8 f64)
  (local $9 f64)
  (local $10 f64)
  (local $11 i64)
  (local $12 i64)
  (local $13 f64)
  (local $14 f64)
  (local $15 f64)
  (local $16 f64)
  (local $17 f64)
  (local $18 i32)
  local.get $1
  f64.abs
  f64.const 2
  f64.le
  if
   local.get $1
   f64.const 2
   f64.eq
   if
    local.get $0
    local.get $0
    f64.mul
    return
   end
   local.get $1
   f64.const 0.5
   f64.eq
   if
    local.get $0
    f64.sqrt
    f64.abs
    f64.const inf
    local.get $0
    f64.const -inf
    f64.ne
    select
    return
   end
   local.get $1
   f64.const -1
   f64.eq
   if
    f64.const 1
    local.get $0
    f64.div
    return
   end
   local.get $1
   f64.const 1
   f64.eq
   if
    local.get $0
    return
   end
   local.get $1
   f64.const 0
   f64.eq
   if
    f64.const 1
    return
   end
  end
  local.get $1
  i64.reinterpret_f64
  local.tee $11
  i64.const 52
  i64.shr_u
  local.set $6
  block $~lib/util/math/pow_lut|inlined.0 (result f64)
   local.get $0
   i64.reinterpret_f64
   local.tee $2
   i64.const 52
   i64.shr_u
   local.tee $5
   i64.const 1
   i64.sub
   i64.const 2046
   i64.ge_u
   if (result i32)
    i32.const 1
   else
    local.get $6
    i64.const 2047
    i64.and
    i64.const 958
    i64.sub
    i64.const 128
    i64.ge_u
   end
   if
    local.get $11
    i64.const 1
    i64.shl
    local.tee $12
    i64.const 1
    i64.sub
    i64.const -9007199254740993
    i64.ge_u
    if
     f64.const 1
     local.get $12
     i64.eqz
     br_if $~lib/util/math/pow_lut|inlined.0
     drop
     f64.const nan:0x8000000000000
     local.get $2
     i64.const 4607182418800017408
     i64.eq
     br_if $~lib/util/math/pow_lut|inlined.0
     drop
     local.get $0
     local.get $1
     f64.add
     local.get $12
     i64.const -9007199254740992
     i64.gt_u
     local.get $2
     i64.const 1
     i64.shl
     local.tee $2
     i64.const -9007199254740992
     i64.gt_u
     i32.or
     br_if $~lib/util/math/pow_lut|inlined.0
     drop
     f64.const nan:0x8000000000000
     local.get $2
     i64.const 9214364837600034816
     i64.eq
     br_if $~lib/util/math/pow_lut|inlined.0
     drop
     f64.const 0
     local.get $11
     i64.const 63
     i64.shr_u
     i64.eqz
     local.get $2
     i64.const 9214364837600034816
     i64.lt_u
     i32.eq
     br_if $~lib/util/math/pow_lut|inlined.0
     drop
     local.get $1
     local.get $1
     f64.mul
     br $~lib/util/math/pow_lut|inlined.0
    end
    local.get $2
    i64.const 1
    i64.shl
    i64.const 1
    i64.sub
    i64.const -9007199254740993
    i64.ge_u
    if
     f64.const 1
     local.get $0
     local.get $0
     f64.mul
     local.tee $0
     f64.neg
     local.get $0
     local.get $2
     i64.const 63
     i64.shr_u
     i32.wrap_i64
     if (result i32)
      block $~lib/util/math/checkint|inlined.0 (result i32)
       i32.const 0
       local.get $11
       i64.const 52
       i64.shr_u
       i64.const 2047
       i64.and
       local.tee $2
       i64.const 1023
       i64.lt_u
       br_if $~lib/util/math/checkint|inlined.0
       drop
       i32.const 2
       local.get $2
       i64.const 1075
       i64.gt_u
       br_if $~lib/util/math/checkint|inlined.0
       drop
       i32.const 0
       local.get $11
       i64.const 1
       i64.const 1075
       local.get $2
       i64.sub
       i64.shl
       local.tee $2
       i64.const 1
       i64.sub
       i64.and
       i64.const 0
       i64.ne
       br_if $~lib/util/math/checkint|inlined.0
       drop
       i32.const 1
       local.get $2
       local.get $11
       i64.and
       i64.const 0
       i64.ne
       br_if $~lib/util/math/checkint|inlined.0
       drop
       i32.const 2
      end
      i32.const 1
      i32.eq
     else
      i32.const 0
     end
     select
     local.tee $0
     f64.div
     local.get $0
     local.get $11
     i64.const 0
     i64.lt_s
     select
     br $~lib/util/math/pow_lut|inlined.0
    end
    local.get $2
    i64.const 0
    i64.lt_s
    if
     block $~lib/util/math/checkint|inlined.1 (result i32)
      i32.const 0
      local.get $11
      i64.const 52
      i64.shr_u
      i64.const 2047
      i64.and
      local.tee $12
      i64.const 1023
      i64.lt_u
      br_if $~lib/util/math/checkint|inlined.1
      drop
      i32.const 2
      local.get $12
      i64.const 1075
      i64.gt_u
      br_if $~lib/util/math/checkint|inlined.1
      drop
      i32.const 0
      local.get $11
      i64.const 1
      i64.const 1075
      local.get $12
      i64.sub
      i64.shl
      local.tee $12
      i64.const 1
      i64.sub
      i64.and
      i64.const 0
      i64.ne
      br_if $~lib/util/math/checkint|inlined.1
      drop
      i32.const 1
      local.get $11
      local.get $12
      i64.and
      i64.const 0
      i64.ne
      br_if $~lib/util/math/checkint|inlined.1
      drop
      i32.const 2
     end
     local.tee $3
     i32.eqz
     if
      local.get $0
      local.get $0
      f64.sub
      local.tee $0
      local.get $0
      f64.div
      br $~lib/util/math/pow_lut|inlined.0
     end
     local.get $5
     i64.const 2047
     i64.and
     local.set $5
     i32.const 262144
     i32.const 0
     local.get $3
     i32.const 1
     i32.eq
     select
     local.set $4
     local.get $2
     i64.const 9223372036854775807
     i64.and
     local.set $2
    end
    local.get $6
    i64.const 2047
    i64.and
    local.tee $12
    i64.const 958
    i64.sub
    i64.const 128
    i64.ge_u
    if
     f64.const 1
     local.get $2
     i64.const 4607182418800017408
     i64.eq
     br_if $~lib/util/math/pow_lut|inlined.0
     drop
     f64.const 1
     local.get $12
     i64.const 958
     i64.lt_u
     br_if $~lib/util/math/pow_lut|inlined.0
     drop
     f64.const inf
     f64.const 0
     local.get $6
     i64.const 2048
     i64.lt_u
     local.get $2
     i64.const 4607182418800017408
     i64.gt_u
     i32.eq
     select
     br $~lib/util/math/pow_lut|inlined.0
    end
    local.get $5
    i64.eqz
    if
     local.get $0
     f64.const 4503599627370496
     f64.mul
     i64.reinterpret_f64
     i64.const 9223372036854775807
     i64.and
     i64.const 234187180623265792
     i64.sub
     local.set $2
    end
   end
   local.get $2
   local.get $2
   i64.const 4604531861337669632
   i64.sub
   local.tee $2
   i64.const -4503599627370496
   i64.and
   i64.sub
   local.tee $5
   i64.const 2147483648
   i64.add
   i64.const -4294967296
   i64.and
   f64.reinterpret_i64
   local.tee $7
   local.get $2
   i64.const 45
   i64.shr_u
   i64.const 127
   i64.and
   i32.wrap_i64
   i32.const 5
   i32.shl
   i32.const 1280
   i32.add
   local.tee $3
   f64.load
   local.tee $8
   f64.mul
   f64.const -1
   f64.add
   local.set $9
   local.get $2
   i64.const 52
   i64.shr_s
   f64.convert_i64_s
   local.tee $13
   f64.const 0.6931471805598903
   f64.mul
   local.get $3
   f64.load offset=16
   f64.add
   local.tee $0
   local.get $9
   local.get $5
   f64.reinterpret_i64
   local.get $7
   f64.sub
   local.get $8
   f64.mul
   local.tee $7
   f64.add
   local.tee $14
   f64.add
   local.set $15
   local.get $14
   local.get $14
   f64.const -0.5
   f64.mul
   local.tee $8
   f64.mul
   local.set $16
   local.get $15
   local.get $9
   local.get $9
   f64.const -0.5
   f64.mul
   local.tee $17
   f64.mul
   local.tee $9
   f64.add
   local.tee $10
   local.get $10
   local.get $13
   f64.const 5.497923018708371e-14
   f64.mul
   local.get $3
   f64.load offset=24
   f64.add
   local.get $0
   local.get $15
   f64.sub
   local.get $14
   f64.add
   f64.add
   local.get $7
   local.get $8
   local.get $17
   f64.add
   f64.mul
   f64.add
   local.get $15
   local.get $10
   f64.sub
   local.get $9
   f64.add
   f64.add
   local.get $14
   local.get $16
   f64.mul
   local.get $14
   f64.const 0.5000000000000007
   f64.mul
   f64.const -0.6666666666666679
   f64.add
   local.get $16
   local.get $14
   f64.const -0.6666666663487739
   f64.mul
   f64.const 0.7999999995323976
   f64.add
   local.get $16
   local.get $14
   f64.const 1.0000415263675542
   f64.mul
   f64.const -1.142909628459501
   f64.add
   f64.mul
   f64.add
   f64.mul
   f64.add
   f64.mul
   f64.add
   local.tee $0
   f64.add
   local.tee $7
   f64.sub
   local.get $0
   f64.add
   global.set $~lib/util/math/log_tail
   local.get $11
   i64.const -134217728
   i64.and
   f64.reinterpret_i64
   local.tee $0
   local.get $7
   i64.reinterpret_f64
   i64.const -134217728
   i64.and
   f64.reinterpret_i64
   local.tee $8
   f64.mul
   local.set $9
   local.get $1
   local.get $0
   f64.sub
   local.get $8
   f64.mul
   local.get $1
   local.get $7
   local.get $8
   f64.sub
   global.get $~lib/util/math/log_tail
   f64.add
   f64.mul
   f64.add
   local.set $0
   block $~lib/util/math/exp_inline|inlined.0 (result f64)
    local.get $9
    i64.reinterpret_f64
    local.tee $2
    i64.const 52
    i64.shr_u
    i32.wrap_i64
    i32.const 2047
    i32.and
    local.tee $3
    i32.const 969
    i32.sub
    local.tee $18
    i32.const 63
    i32.ge_u
    if
     f64.const -1
     f64.const 1
     local.get $4
     select
     local.get $18
     i32.const -2147483648
     i32.ge_u
     br_if $~lib/util/math/exp_inline|inlined.0
     drop
     f64.const -0
     f64.const 0
     local.get $4
     select
     f64.const -inf
     f64.const inf
     local.get $4
     select
     local.get $2
     i64.const 0
     i64.lt_s
     select
     local.get $3
     i32.const 1033
     i32.ge_u
     br_if $~lib/util/math/exp_inline|inlined.0
     drop
     i32.const 0
     local.set $3
    end
    local.get $9
    f64.const 184.6649652337873
    f64.mul
    f64.const 6755399441055744
    f64.add
    local.tee $1
    i64.reinterpret_f64
    local.tee $2
    i64.const 127
    i64.and
    i64.const 1
    i64.shl
    i32.wrap_i64
    i32.const 3
    i32.shl
    i32.const 5376
    i32.add
    local.tee $18
    i64.load offset=8
    local.get $2
    local.get $4
    i64.extend_i32_u
    i64.add
    i64.const 45
    i64.shl
    i64.add
    local.set $5
    local.get $9
    local.get $1
    f64.const -6755399441055744
    f64.add
    local.tee $1
    f64.const -0.005415212348111709
    f64.mul
    f64.add
    local.get $1
    f64.const -1.2864023111638346e-14
    f64.mul
    f64.add
    local.get $0
    f64.add
    local.tee $0
    local.get $0
    f64.mul
    local.set $1
    local.get $18
    f64.load
    local.get $0
    f64.add
    local.get $1
    local.get $0
    f64.const 0.16666666666665886
    f64.mul
    f64.const 0.49999999999996786
    f64.add
    f64.mul
    f64.add
    local.get $1
    local.get $1
    f64.mul
    local.get $0
    f64.const 0.008333335853059549
    f64.mul
    f64.const 0.0416666808410674
    f64.add
    f64.mul
    f64.add
    local.set $0
    local.get $3
    i32.eqz
    if
     block $~lib/util/math/specialcase|inlined.0 (result f64)
      local.get $2
      i64.const 2147483648
      i64.and
      i64.eqz
      if
       local.get $5
       i64.const 4544132024016830464
       i64.sub
       f64.reinterpret_i64
       local.tee $1
       local.get $1
       local.get $0
       f64.mul
       f64.add
       f64.const 5486124068793688683255936e279
       f64.mul
       br $~lib/util/math/specialcase|inlined.0
      end
      local.get $5
      i64.const 4602678819172646912
      i64.add
      local.tee $2
      f64.reinterpret_i64
      local.tee $1
      local.get $0
      f64.mul
      local.set $0
      local.get $1
      local.get $0
      f64.add
      local.tee $7
      f64.abs
      f64.const 1
      f64.lt
      if (result f64)
       f64.const 1
       local.get $7
       f64.copysign
       local.tee $8
       local.get $7
       f64.add
       local.tee $9
       local.get $8
       local.get $9
       f64.sub
       local.get $7
       f64.add
       local.get $1
       local.get $7
       f64.sub
       local.get $0
       f64.add
       f64.add
       f64.add
       local.get $8
       f64.sub
       local.tee $0
       f64.const 0
       f64.eq
       if (result f64)
        local.get $2
        i64.const -9223372036854775808
        i64.and
        f64.reinterpret_i64
       else
        local.get $0
       end
      else
       local.get $7
      end
      f64.const 2.2250738585072014e-308
      f64.mul
     end
     br $~lib/util/math/exp_inline|inlined.0
    end
    local.get $5
    f64.reinterpret_i64
    local.tee $1
    local.get $1
    local.get $0
    f64.mul
    f64.add
   end
  end
 )
 (func $src/fluid/as-src/sph/recomputeKernelConstants
  global.get $src/fluid/as-src/sph/h
  global.get $src/fluid/as-src/sph/h
  f64.mul
  global.set $src/fluid/as-src/sph/h2
  f64.const 4
  global.get $src/fluid/as-src/sph/h
  f64.const 8
  call $~lib/math/NativeMath.pow
  f64.const 3.141592653589793
  f64.mul
  f64.div
  global.set $src/fluid/as-src/sph/poly6Coef
  f64.const 30
  global.get $src/fluid/as-src/sph/h
  f64.const 5
  call $~lib/math/NativeMath.pow
  f64.const 3.141592653589793
  f64.mul
  f64.div
  global.set $src/fluid/as-src/sph/spikyGradCoef
  f64.const 40
  global.get $src/fluid/as-src/sph/h
  f64.const 5
  call $~lib/math/NativeMath.pow
  f64.const 3.141592653589793
  f64.mul
  f64.div
  global.set $src/fluid/as-src/sph/viscLapCoef
 )
 (func $~start
  (local $0 i32)
  i32.const 7532
  global.set $~lib/rt/stub/offset
  i32.const 32768
  i32.const 4
  call $~lib/rt/stub/__new
  local.tee $0
  i32.const 0
  i32.const 32768
  memory.fill
  local.get $0
  global.set $src/fluid/as-src/sph/posX
  i32.const 32768
  i32.const 4
  call $~lib/rt/stub/__new
  local.tee $0
  i32.const 0
  i32.const 32768
  memory.fill
  local.get $0
  global.set $src/fluid/as-src/sph/posY
  i32.const 32768
  i32.const 4
  call $~lib/rt/stub/__new
  local.tee $0
  i32.const 0
  i32.const 32768
  memory.fill
  local.get $0
  global.set $src/fluid/as-src/sph/velX
  i32.const 32768
  i32.const 4
  call $~lib/rt/stub/__new
  local.tee $0
  i32.const 0
  i32.const 32768
  memory.fill
  local.get $0
  global.set $src/fluid/as-src/sph/velY
  i32.const 32768
  i32.const 4
  call $~lib/rt/stub/__new
  local.tee $0
  i32.const 0
  i32.const 32768
  memory.fill
  local.get $0
  global.set $src/fluid/as-src/sph/density
  i32.const 32768
  i32.const 4
  call $~lib/rt/stub/__new
  local.tee $0
  i32.const 0
  i32.const 32768
  memory.fill
  local.get $0
  global.set $src/fluid/as-src/sph/pressure
  i32.const 32768
  i32.const 4
  call $~lib/rt/stub/__new
  local.tee $0
  i32.const 0
  i32.const 32768
  memory.fill
  local.get $0
  global.set $src/fluid/as-src/sph/forceX
  i32.const 32768
  i32.const 4
  call $~lib/rt/stub/__new
  local.tee $0
  i32.const 0
  i32.const 32768
  memory.fill
  local.get $0
  global.set $src/fluid/as-src/sph/forceY
  call $src/fluid/as-src/sph/recomputeKernelConstants
  i32.const 16384
  i32.const 5
  call $~lib/rt/stub/__new
  local.tee $0
  i32.const 0
  i32.const 16384
  memory.fill
  local.get $0
  global.set $src/fluid/as-src/sph/cellCount
  i32.const 16384
  i32.const 5
  call $~lib/rt/stub/__new
  local.tee $0
  i32.const 0
  i32.const 16384
  memory.fill
  local.get $0
  global.set $src/fluid/as-src/sph/cellStart
  i32.const 16384
  i32.const 5
  call $~lib/rt/stub/__new
  local.tee $0
  i32.const 0
  i32.const 16384
  memory.fill
  local.get $0
  global.set $src/fluid/as-src/sph/sortedIdx
  i32.const 16384
  i32.const 5
  call $~lib/rt/stub/__new
  local.tee $0
  i32.const 0
  i32.const 16384
  memory.fill
  local.get $0
  global.set $src/fluid/as-src/sph/particleCell
 )
 (func $~lib/rt/stub/__unpin (param $0 i32)
 )
 (func $~lib/rt/stub/__pin (param $0 i32) (result i32)
  local.get $0
 )
 (func $~lib/rt/stub/__collect
 )
 (func $src/fluid/as-src/sph/step (param $0 f64)
  (local $1 f64)
  (local $2 i32)
  (local $3 i32)
  (local $4 i32)
  (local $5 i32)
  (local $6 i32)
  (local $7 i32)
  (local $8 i32)
  (local $9 i32)
  (local $10 i32)
  (local $11 f64)
  global.get $src/fluid/as-src/sph/boundMinX
  global.set $src/fluid/as-src/sph/gridOriginX
  global.get $src/fluid/as-src/sph/boundMinY
  global.set $src/fluid/as-src/sph/gridOriginY
  loop $for-loop|0
   local.get $3
   i32.const 4096
   i32.lt_s
   if
    global.get $src/fluid/as-src/sph/cellCount
    local.get $3
    i32.const 0
    call $~lib/staticarray/StaticArray<i32>#__set
    local.get $3
    i32.const 1
    i32.add
    local.set $3
    br $for-loop|0
   end
  end
  i32.const 0
  local.set $3
  loop $for-loop|1
   local.get $3
   global.get $src/fluid/as-src/sph/particleCount
   i32.lt_s
   if
    global.get $src/fluid/as-src/sph/posX
    local.get $3
    call $~lib/staticarray/StaticArray<f64>#__get
    local.set $1
    global.get $src/fluid/as-src/sph/posY
    local.get $3
    call $~lib/staticarray/StaticArray<f64>#__get
    global.get $src/fluid/as-src/sph/gridOriginY
    f64.sub
    global.get $src/fluid/as-src/sph/h
    f64.div
    f64.floor
    i32.trunc_sat_f64_s
    local.set $2
    global.get $src/fluid/as-src/sph/particleCell
    local.get $3
    i32.const 63
    local.get $2
    i32.const 0
    local.get $2
    i32.const 0
    i32.ge_s
    select
    local.tee $2
    local.get $2
    i32.const 64
    i32.ge_s
    select
    i32.const 6
    i32.shl
    local.get $1
    global.get $src/fluid/as-src/sph/gridOriginX
    f64.sub
    global.get $src/fluid/as-src/sph/h
    f64.div
    f64.floor
    i32.trunc_sat_f64_s
    local.tee $2
    i32.const 0
    i32.lt_s
    if
     i32.const 0
     local.set $2
    end
    i32.const 63
    local.get $2
    local.get $2
    i32.const 64
    i32.ge_s
    select
    i32.add
    local.tee $2
    call $~lib/staticarray/StaticArray<i32>#__set
    global.get $src/fluid/as-src/sph/cellCount
    local.get $2
    global.get $src/fluid/as-src/sph/cellCount
    local.get $2
    call $~lib/staticarray/StaticArray<i32>#__get
    i32.const 1
    i32.add
    call $~lib/staticarray/StaticArray<i32>#__set
    local.get $3
    i32.const 1
    i32.add
    local.set $3
    br $for-loop|1
   end
  end
  i32.const 0
  local.set $2
  i32.const 0
  local.set $3
  loop $for-loop|2
   local.get $3
   i32.const 4096
   i32.lt_s
   if
    global.get $src/fluid/as-src/sph/cellStart
    local.get $3
    local.get $2
    call $~lib/staticarray/StaticArray<i32>#__set
    global.get $src/fluid/as-src/sph/cellCount
    local.get $3
    call $~lib/staticarray/StaticArray<i32>#__get
    local.get $2
    i32.add
    local.set $2
    local.get $3
    i32.const 1
    i32.add
    local.set $3
    br $for-loop|2
   end
  end
  i32.const 16384
  i32.const 5
  call $~lib/rt/stub/__new
  local.tee $2
  i32.const 0
  i32.const 16384
  memory.fill
  i32.const 0
  local.set $3
  loop $for-loop|3
   local.get $3
   i32.const 4096
   i32.lt_s
   if
    local.get $2
    local.get $3
    global.get $src/fluid/as-src/sph/cellStart
    local.get $3
    call $~lib/staticarray/StaticArray<i32>#__get
    call $~lib/staticarray/StaticArray<i32>#__set
    local.get $3
    i32.const 1
    i32.add
    local.set $3
    br $for-loop|3
   end
  end
  i32.const 0
  local.set $3
  loop $for-loop|4
   local.get $3
   global.get $src/fluid/as-src/sph/particleCount
   i32.lt_s
   if
    global.get $src/fluid/as-src/sph/particleCell
    local.get $3
    call $~lib/staticarray/StaticArray<i32>#__get
    local.set $4
    global.get $src/fluid/as-src/sph/sortedIdx
    local.get $2
    local.get $4
    call $~lib/staticarray/StaticArray<i32>#__get
    local.get $3
    call $~lib/staticarray/StaticArray<i32>#__set
    local.get $2
    local.get $4
    local.get $2
    local.get $4
    call $~lib/staticarray/StaticArray<i32>#__get
    i32.const 1
    i32.add
    call $~lib/staticarray/StaticArray<i32>#__set
    local.get $3
    i32.const 1
    i32.add
    local.set $3
    br $for-loop|4
   end
  end
  loop $for-loop|00
   local.get $5
   global.get $src/fluid/as-src/sph/particleCount
   i32.lt_s
   if
    global.get $src/fluid/as-src/sph/posX
    local.get $5
    call $~lib/staticarray/StaticArray<f64>#__get
    global.get $src/fluid/as-src/sph/gridOriginX
    f64.sub
    global.get $src/fluid/as-src/sph/h
    f64.div
    f64.floor
    i32.trunc_sat_f64_s
    local.set $7
    global.get $src/fluid/as-src/sph/posY
    local.get $5
    call $~lib/staticarray/StaticArray<f64>#__get
    global.get $src/fluid/as-src/sph/gridOriginY
    f64.sub
    global.get $src/fluid/as-src/sph/h
    f64.div
    f64.floor
    i32.trunc_sat_f64_s
    local.set $8
    f64.const 0
    local.set $1
    i32.const -1
    local.set $2
    loop $for-loop|11
     local.get $2
     i32.const 1
     i32.le_s
     if
      local.get $2
      local.get $8
      i32.add
      local.tee $6
      i32.const 0
      i32.lt_s
      local.get $6
      i32.const 64
      i32.ge_s
      i32.or
      i32.eqz
      if
       i32.const -1
       local.set $4
       loop $for-loop|22
        local.get $4
        i32.const 1
        i32.le_s
        if
         local.get $4
         local.get $7
         i32.add
         local.tee $3
         i32.const 0
         i32.lt_s
         local.get $3
         i32.const 64
         i32.ge_s
         i32.or
         i32.eqz
         if
          global.get $src/fluid/as-src/sph/cellStart
          local.get $6
          i32.const 6
          i32.shl
          local.get $3
          i32.add
          local.tee $9
          call $~lib/staticarray/StaticArray<i32>#__get
          local.set $3
          global.get $src/fluid/as-src/sph/cellCount
          local.get $9
          call $~lib/staticarray/StaticArray<i32>#__get
          local.get $3
          i32.add
          local.set $10
          loop $for-loop|33
           local.get $3
           local.get $10
           i32.lt_s
           if
            global.get $src/fluid/as-src/sph/sortedIdx
            local.get $3
            call $~lib/staticarray/StaticArray<i32>#__get
            local.set $9
            global.get $src/fluid/as-src/sph/posX
            local.get $5
            call $~lib/staticarray/StaticArray<f64>#__get
            global.get $src/fluid/as-src/sph/posX
            local.get $9
            call $~lib/staticarray/StaticArray<f64>#__get
            f64.sub
            local.tee $11
            local.get $11
            f64.mul
            global.get $src/fluid/as-src/sph/posY
            local.get $5
            call $~lib/staticarray/StaticArray<f64>#__get
            global.get $src/fluid/as-src/sph/posY
            local.get $9
            call $~lib/staticarray/StaticArray<f64>#__get
            f64.sub
            local.tee $11
            local.get $11
            f64.mul
            f64.add
            local.tee $11
            global.get $src/fluid/as-src/sph/h2
            f64.lt
            if
             local.get $1
             global.get $src/fluid/as-src/sph/particleMass
             global.get $src/fluid/as-src/sph/poly6Coef
             f64.mul
             global.get $src/fluid/as-src/sph/h2
             local.get $11
             f64.sub
             local.tee $1
             f64.mul
             local.get $1
             f64.mul
             local.get $1
             f64.mul
             f64.add
             local.set $1
            end
            local.get $3
            i32.const 1
            i32.add
            local.set $3
            br $for-loop|33
           end
          end
         end
         local.get $4
         i32.const 1
         i32.add
         local.set $4
         br $for-loop|22
        end
       end
      end
      local.get $2
      i32.const 1
      i32.add
      local.set $2
      br $for-loop|11
     end
    end
    global.get $src/fluid/as-src/sph/density
    local.get $5
    local.get $1
    call $~lib/staticarray/StaticArray<f64>#__set
    global.get $src/fluid/as-src/sph/pressure
    local.get $5
    global.get $src/fluid/as-src/sph/gasConstant
    local.get $1
    global.get $src/fluid/as-src/sph/restDensity
    f64.sub
    f64.mul
    local.tee $1
    f64.const 0
    local.get $1
    f64.const 0
    f64.gt
    select
    call $~lib/staticarray/StaticArray<f64>#__set
    local.get $5
    i32.const 1
    i32.add
    local.set $5
    br $for-loop|00
   end
  end
  call $src/fluid/as-src/sph/computeForces
  i32.const 0
  local.set $3
  loop $for-loop|004
   local.get $3
   global.get $src/fluid/as-src/sph/particleCount
   i32.lt_s
   if
    global.get $src/fluid/as-src/sph/density
    local.get $3
    call $~lib/staticarray/StaticArray<f64>#__get
    f64.const 1e-06
    f64.gt
    if (result f64)
     global.get $src/fluid/as-src/sph/density
     local.get $3
     call $~lib/staticarray/StaticArray<f64>#__get
    else
     f64.const 1e-06
    end
    local.set $1
    global.get $src/fluid/as-src/sph/velX
    local.get $3
    global.get $src/fluid/as-src/sph/velX
    local.get $3
    call $~lib/staticarray/StaticArray<f64>#__get
    local.get $0
    global.get $src/fluid/as-src/sph/forceX
    local.get $3
    call $~lib/staticarray/StaticArray<f64>#__get
    f64.mul
    local.get $1
    f64.div
    f64.add
    call $~lib/staticarray/StaticArray<f64>#__set
    global.get $src/fluid/as-src/sph/velY
    local.get $3
    global.get $src/fluid/as-src/sph/velY
    local.get $3
    call $~lib/staticarray/StaticArray<f64>#__get
    local.get $0
    global.get $src/fluid/as-src/sph/forceY
    local.get $3
    call $~lib/staticarray/StaticArray<f64>#__get
    f64.mul
    local.get $1
    f64.div
    f64.add
    call $~lib/staticarray/StaticArray<f64>#__set
    global.get $src/fluid/as-src/sph/posX
    local.get $3
    global.get $src/fluid/as-src/sph/posX
    local.get $3
    call $~lib/staticarray/StaticArray<f64>#__get
    local.get $0
    global.get $src/fluid/as-src/sph/velX
    local.get $3
    call $~lib/staticarray/StaticArray<f64>#__get
    f64.mul
    f64.add
    call $~lib/staticarray/StaticArray<f64>#__set
    global.get $src/fluid/as-src/sph/posY
    local.get $3
    global.get $src/fluid/as-src/sph/posY
    local.get $3
    call $~lib/staticarray/StaticArray<f64>#__get
    local.get $0
    global.get $src/fluid/as-src/sph/velY
    local.get $3
    call $~lib/staticarray/StaticArray<f64>#__get
    f64.mul
    f64.add
    call $~lib/staticarray/StaticArray<f64>#__set
    global.get $src/fluid/as-src/sph/posX
    local.get $3
    call $~lib/staticarray/StaticArray<f64>#__get
    global.get $src/fluid/as-src/sph/boundMinX
    f64.lt
    if
     global.get $src/fluid/as-src/sph/posX
     local.get $3
     global.get $src/fluid/as-src/sph/boundMinX
     call $~lib/staticarray/StaticArray<f64>#__set
     global.get $src/fluid/as-src/sph/velX
     local.get $3
     global.get $src/fluid/as-src/sph/velX
     local.get $3
     call $~lib/staticarray/StaticArray<f64>#__get
     f64.neg
     global.get $src/fluid/as-src/sph/boundaryDamping
     f64.mul
     call $~lib/staticarray/StaticArray<f64>#__set
    else
     global.get $src/fluid/as-src/sph/posX
     local.get $3
     call $~lib/staticarray/StaticArray<f64>#__get
     global.get $src/fluid/as-src/sph/boundMaxX
     f64.gt
     if
      global.get $src/fluid/as-src/sph/posX
      local.get $3
      global.get $src/fluid/as-src/sph/boundMaxX
      call $~lib/staticarray/StaticArray<f64>#__set
      global.get $src/fluid/as-src/sph/velX
      local.get $3
      global.get $src/fluid/as-src/sph/velX
      local.get $3
      call $~lib/staticarray/StaticArray<f64>#__get
      f64.neg
      global.get $src/fluid/as-src/sph/boundaryDamping
      f64.mul
      call $~lib/staticarray/StaticArray<f64>#__set
     end
    end
    global.get $src/fluid/as-src/sph/posY
    local.get $3
    call $~lib/staticarray/StaticArray<f64>#__get
    global.get $src/fluid/as-src/sph/boundMinY
    f64.lt
    if
     global.get $src/fluid/as-src/sph/posY
     local.get $3
     global.get $src/fluid/as-src/sph/boundMinY
     call $~lib/staticarray/StaticArray<f64>#__set
     global.get $src/fluid/as-src/sph/velY
     local.get $3
     global.get $src/fluid/as-src/sph/velY
     local.get $3
     call $~lib/staticarray/StaticArray<f64>#__get
     f64.neg
     global.get $src/fluid/as-src/sph/boundaryDamping
     f64.mul
     call $~lib/staticarray/StaticArray<f64>#__set
    else
     global.get $src/fluid/as-src/sph/posY
     local.get $3
     call $~lib/staticarray/StaticArray<f64>#__get
     global.get $src/fluid/as-src/sph/boundMaxY
     f64.gt
     if
      global.get $src/fluid/as-src/sph/posY
      local.get $3
      global.get $src/fluid/as-src/sph/boundMaxY
      call $~lib/staticarray/StaticArray<f64>#__set
      global.get $src/fluid/as-src/sph/velY
      local.get $3
      global.get $src/fluid/as-src/sph/velY
      local.get $3
      call $~lib/staticarray/StaticArray<f64>#__get
      f64.neg
      global.get $src/fluid/as-src/sph/boundaryDamping
      f64.mul
      call $~lib/staticarray/StaticArray<f64>#__set
     end
    end
    local.get $3
    i32.const 1
    i32.add
    local.set $3
    br $for-loop|004
   end
  end
 )
 (func $src/fluid/as-src/sph/reset
  i32.const 0
  global.set $src/fluid/as-src/sph/particleCount
 )
 (func $src/fluid/as-src/sph/posYPtr (result i32)
  global.get $src/fluid/as-src/sph/posY
 )
 (func $src/fluid/as-src/sph/posXPtr (result i32)
  global.get $src/fluid/as-src/sph/posX
 )
 (func $src/fluid/as-src/sph/getVelY (param $0 i32) (result f64)
  global.get $src/fluid/as-src/sph/velY
  local.get $0
  call $~lib/staticarray/StaticArray<f64>#__get
 )
 (func $src/fluid/as-src/sph/getVelX (param $0 i32) (result f64)
  global.get $src/fluid/as-src/sph/velX
  local.get $0
  call $~lib/staticarray/StaticArray<f64>#__get
 )
 (func $src/fluid/as-src/sph/getPressure (param $0 i32) (result f64)
  global.get $src/fluid/as-src/sph/pressure
  local.get $0
  call $~lib/staticarray/StaticArray<f64>#__get
 )
 (func $src/fluid/as-src/sph/getPosY (param $0 i32) (result f64)
  global.get $src/fluid/as-src/sph/posY
  local.get $0
  call $~lib/staticarray/StaticArray<f64>#__get
 )
 (func $src/fluid/as-src/sph/getPosX (param $0 i32) (result f64)
  global.get $src/fluid/as-src/sph/posX
  local.get $0
  call $~lib/staticarray/StaticArray<f64>#__get
 )
 (func $src/fluid/as-src/sph/getParticleCount (result i32)
  global.get $src/fluid/as-src/sph/particleCount
 )
 (func $src/fluid/as-src/sph/getDensity (param $0 i32) (result f64)
  global.get $src/fluid/as-src/sph/density
  local.get $0
  call $~lib/staticarray/StaticArray<f64>#__get
 )
 (func $src/fluid/as-src/sph/estimateParticleMass (param $0 f64) (param $1 f64) (result f64)
  (local $2 f64)
  (local $3 i32)
  (local $4 i32)
  (local $5 i32)
  (local $6 f64)
  i32.const 0
  global.get $src/fluid/as-src/sph/h
  local.get $0
  f64.div
  f64.ceil
  i32.trunc_sat_f64_s
  i32.const 1
  i32.add
  local.tee $5
  i32.sub
  local.set $3
  loop $for-loop|0
   local.get $3
   local.get $5
   i32.le_s
   if
    i32.const 0
    local.get $5
    i32.sub
    local.set $4
    loop $for-loop|1
     local.get $4
     local.get $5
     i32.le_s
     if
      local.get $3
      f64.convert_i32_s
      local.get $0
      f64.mul
      local.tee $6
      local.get $6
      f64.mul
      local.get $4
      f64.convert_i32_s
      local.get $0
      f64.mul
      local.tee $6
      local.get $6
      f64.mul
      f64.add
      local.tee $6
      global.get $src/fluid/as-src/sph/h2
      f64.lt
      if
       local.get $2
       global.get $src/fluid/as-src/sph/poly6Coef
       global.get $src/fluid/as-src/sph/h2
       local.get $6
       f64.sub
       local.tee $2
       f64.mul
       local.get $2
       f64.mul
       local.get $2
       f64.mul
       f64.add
       local.set $2
      end
      local.get $4
      i32.const 1
      i32.add
      local.set $4
      br $for-loop|1
     end
    end
    local.get $3
    i32.const 1
    i32.add
    local.set $3
    br $for-loop|0
   end
  end
  local.get $2
  f64.const 1e-09
  f64.lt
  if
   local.get $1
   return
  end
  local.get $1
  local.get $2
  f64.div
 )
 (func $src/fluid/as-src/sph/configure (param $0 f64) (param $1 f64) (param $2 f64) (param $3 f64) (param $4 f64) (param $5 f64) (param $6 f64) (param $7 f64) (param $8 f64) (param $9 f64) (param $10 f64)
  local.get $0
  global.set $src/fluid/as-src/sph/h
  local.get $1
  global.set $src/fluid/as-src/sph/restDensity
  local.get $2
  global.set $src/fluid/as-src/sph/gasConstant
  local.get $3
  global.set $src/fluid/as-src/sph/viscosityMu
  local.get $4
  global.set $src/fluid/as-src/sph/particleMass
  local.get $5
  global.set $src/fluid/as-src/sph/gravityY
  local.get $6
  global.set $src/fluid/as-src/sph/boundMinX
  local.get $7
  global.set $src/fluid/as-src/sph/boundMinY
  local.get $8
  global.set $src/fluid/as-src/sph/boundMaxX
  local.get $9
  global.set $src/fluid/as-src/sph/boundMaxY
  local.get $10
  global.set $src/fluid/as-src/sph/boundaryDamping
  call $src/fluid/as-src/sph/recomputeKernelConstants
 )
 (func $src/fluid/as-src/sph/computeForces
  (local $0 f64)
  (local $1 i32)
  (local $2 i32)
  (local $3 i32)
  (local $4 i32)
  (local $5 f64)
  (local $6 f64)
  (local $7 f64)
  (local $8 i32)
  (local $9 f64)
  (local $10 f64)
  (local $11 i32)
  (local $12 i32)
  (local $13 f64)
  (local $14 i32)
  (local $15 f64)
  (local $16 f64)
  (local $17 i32)
  (local $18 f64)
  (local $19 f64)
  loop $for-loop|0
   local.get $1
   global.get $src/fluid/as-src/sph/particleCount
   i32.lt_s
   if
    global.get $src/fluid/as-src/sph/posX
    local.get $1
    call $~lib/staticarray/StaticArray<f64>#__get
    global.get $src/fluid/as-src/sph/gridOriginX
    f64.sub
    global.get $src/fluid/as-src/sph/h
    f64.div
    f64.floor
    i32.trunc_sat_f64_s
    local.set $11
    global.get $src/fluid/as-src/sph/posY
    local.get $1
    call $~lib/staticarray/StaticArray<f64>#__get
    global.get $src/fluid/as-src/sph/gridOriginY
    f64.sub
    global.get $src/fluid/as-src/sph/h
    f64.div
    f64.floor
    i32.trunc_sat_f64_s
    local.set $12
    f64.const 0
    local.set $5
    f64.const 0
    local.set $6
    f64.const 0
    local.set $7
    f64.const 0
    local.set $0
    global.get $src/fluid/as-src/sph/density
    local.get $1
    call $~lib/staticarray/StaticArray<f64>#__get
    local.set $13
    i32.const -1
    local.set $3
    loop $for-loop|1
     local.get $3
     i32.const 1
     i32.le_s
     if
      local.get $3
      local.get $12
      i32.add
      local.tee $8
      i32.const 0
      i32.lt_s
      local.get $8
      i32.const 64
      i32.ge_s
      i32.or
      i32.eqz
      if
       i32.const -1
       local.set $4
       loop $for-loop|2
        local.get $4
        i32.const 1
        i32.le_s
        if
         local.get $4
         local.get $11
         i32.add
         local.tee $2
         i32.const 0
         i32.lt_s
         local.get $2
         i32.const 64
         i32.ge_s
         i32.or
         i32.eqz
         if
          global.get $src/fluid/as-src/sph/cellStart
          local.get $8
          i32.const 6
          i32.shl
          local.get $2
          i32.add
          local.tee $14
          call $~lib/staticarray/StaticArray<i32>#__get
          local.set $2
          global.get $src/fluid/as-src/sph/cellCount
          local.get $14
          call $~lib/staticarray/StaticArray<i32>#__get
          local.get $2
          i32.add
          local.set $17
          loop $for-loop|3
           local.get $2
           local.get $17
           i32.lt_s
           if
            global.get $src/fluid/as-src/sph/sortedIdx
            local.get $2
            call $~lib/staticarray/StaticArray<i32>#__get
            local.tee $14
            local.get $1
            i32.ne
            if
             global.get $src/fluid/as-src/sph/posX
             local.get $1
             call $~lib/staticarray/StaticArray<f64>#__get
             global.get $src/fluid/as-src/sph/posX
             local.get $14
             call $~lib/staticarray/StaticArray<f64>#__get
             f64.sub
             local.tee $9
             local.get $9
             f64.mul
             global.get $src/fluid/as-src/sph/posY
             local.get $1
             call $~lib/staticarray/StaticArray<f64>#__get
             global.get $src/fluid/as-src/sph/posY
             local.get $14
             call $~lib/staticarray/StaticArray<f64>#__get
             f64.sub
             local.tee $10
             local.get $10
             f64.mul
             f64.add
             local.tee $15
             f64.const 1e-12
             f64.gt
             local.get $15
             global.get $src/fluid/as-src/sph/h2
             f64.lt
             i32.and
             if
              global.get $src/fluid/as-src/sph/density
              local.get $14
              call $~lib/staticarray/StaticArray<f64>#__get
              local.set $18
              global.get $src/fluid/as-src/sph/spikyGradCoef
              global.get $src/fluid/as-src/sph/h
              local.get $15
              f64.sqrt
              local.tee $15
              f64.sub
              local.tee $16
              f64.mul
              local.get $16
              f64.mul
              local.set $16
              global.get $src/fluid/as-src/sph/pressure
              local.get $1
              call $~lib/staticarray/StaticArray<f64>#__get
              global.get $src/fluid/as-src/sph/pressure
              local.get $14
              call $~lib/staticarray/StaticArray<f64>#__get
              f64.add
              local.get $18
              local.get $18
              f64.add
              f64.div
              local.set $19
              local.get $5
              global.get $src/fluid/as-src/sph/particleMass
              f64.neg
              local.get $19
              f64.mul
              local.get $16
              f64.mul
              local.tee $16
              local.get $9
              local.get $15
              f64.div
              f64.mul
              f64.add
              local.set $5
              local.get $6
              local.get $16
              local.get $10
              local.get $15
              f64.div
              f64.mul
              f64.add
              local.set $6
              local.get $7
              global.get $src/fluid/as-src/sph/viscosityMu
              global.get $src/fluid/as-src/sph/particleMass
              f64.mul
              global.get $src/fluid/as-src/sph/viscLapCoef
              global.get $src/fluid/as-src/sph/h
              local.get $15
              f64.sub
              f64.mul
              f64.mul
              local.get $18
              f64.div
              local.tee $9
              global.get $src/fluid/as-src/sph/velX
              local.get $14
              call $~lib/staticarray/StaticArray<f64>#__get
              global.get $src/fluid/as-src/sph/velX
              local.get $1
              call $~lib/staticarray/StaticArray<f64>#__get
              f64.sub
              f64.mul
              f64.add
              local.set $7
              local.get $0
              local.get $9
              global.get $src/fluid/as-src/sph/velY
              local.get $14
              call $~lib/staticarray/StaticArray<f64>#__get
              global.get $src/fluid/as-src/sph/velY
              local.get $1
              call $~lib/staticarray/StaticArray<f64>#__get
              f64.sub
              f64.mul
              f64.add
              local.set $0
             end
            end
            local.get $2
            i32.const 1
            i32.add
            local.set $2
            br $for-loop|3
           end
          end
         end
         local.get $4
         i32.const 1
         i32.add
         local.set $4
         br $for-loop|2
        end
       end
      end
      local.get $3
      i32.const 1
      i32.add
      local.set $3
      br $for-loop|1
     end
    end
    global.get $src/fluid/as-src/sph/forceX
    local.get $1
    local.get $5
    local.get $7
    f64.add
    call $~lib/staticarray/StaticArray<f64>#__set
    global.get $src/fluid/as-src/sph/forceY
    local.get $1
    local.get $6
    local.get $0
    f64.add
    global.get $src/fluid/as-src/sph/gravityY
    local.get $13
    f64.mul
    f64.add
    call $~lib/staticarray/StaticArray<f64>#__set
    local.get $1
    i32.const 1
    i32.add
    local.set $1
    br $for-loop|0
   end
  end
 )
 (func $src/fluid/as-src/sph/addParticle (param $0 f64) (param $1 f64) (param $2 f64) (param $3 f64) (result i32)
  (local $4 i32)
  global.get $src/fluid/as-src/sph/particleCount
  i32.const 4096
  i32.ge_s
  if
   i32.const -1
   return
  end
  global.get $src/fluid/as-src/sph/posX
  global.get $src/fluid/as-src/sph/particleCount
  local.tee $4
  local.get $0
  call $~lib/staticarray/StaticArray<f64>#__set
  global.get $src/fluid/as-src/sph/posY
  local.get $4
  local.get $1
  call $~lib/staticarray/StaticArray<f64>#__set
  global.get $src/fluid/as-src/sph/velX
  local.get $4
  local.get $2
  call $~lib/staticarray/StaticArray<f64>#__set
  global.get $src/fluid/as-src/sph/velY
  local.get $4
  local.get $3
  call $~lib/staticarray/StaticArray<f64>#__set
  global.get $src/fluid/as-src/sph/density
  local.get $4
  global.get $src/fluid/as-src/sph/restDensity
  call $~lib/staticarray/StaticArray<f64>#__set
  global.get $src/fluid/as-src/sph/pressure
  local.get $4
  f64.const 0
  call $~lib/staticarray/StaticArray<f64>#__set
  global.get $src/fluid/as-src/sph/forceX
  local.get $4
  f64.const 0
  call $~lib/staticarray/StaticArray<f64>#__set
  global.get $src/fluid/as-src/sph/forceY
  local.get $4
  f64.const 0
  call $~lib/staticarray/StaticArray<f64>#__set
  global.get $src/fluid/as-src/sph/particleCount
  i32.const 1
  i32.add
  global.set $src/fluid/as-src/sph/particleCount
  local.get $4
 )
)
