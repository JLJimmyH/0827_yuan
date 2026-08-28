%
O9001(CHECK-4AXIS)
(=========================================)
(4-AXIS CALIBRATION - ANSWER Q0..Q4)
(RUN IT OR JUST READ IT. BOTH OK.)
(SAFE: RETRACT TO Z50. BEFORE EVERY INDEX)
(=========================================)
(Q0: WORK DIAMETER = ? MM)
(=========================================)
G40G49G80
M6T1(SG-6.)
G0G90G54X10.Y0.A0.G43H1Z50.M3S800
M8
(-----------------------------------------)
(Q1: NEXT CUT GOES TO Z10. - A PLUS VALUE)
(    A. DOES IT TOUCH THE WORK ? YES / NO)
(    B. IF YES, HOLE DEPTH = ? MM)
(-----------------------------------------)
G98G81Z10.R30.F80.
(-----------------------------------------)
(Q2: NEXT CUT GOES TO Z0. - EXACTLY ZERO)
(    A. DOES IT TOUCH THE WORK ? YES / NO)
(    B. IF YES, HOLE DEPTH = ? MM)
(-----------------------------------------)
X20.Z0.
(-----------------------------------------)
(Q3: NEXT CUT IS OFFSET TO Y10.)
(    NOT ABOVE THE AXIS CENTRE)
(    ROUND HOLE ? OR CUT OFF THE SIDE ?)
(-----------------------------------------)
X30.Y10.Z0.
G80
M9
G0Z50.
(-----------------------------------------)
(Q4: NEXT CUT IS AT A90. X40.)
(    TURN THE WORK BACK TO A0.)
(    WHICH FACE IS THAT HOLE ON ?)
(    TOP / BOTTOM / FRONT / BACK)
(    FRONT = FACING THE OPERATOR)
(-----------------------------------------)
G0Y0.A90.
G98G81X40.Z0.R30.F80.
G80
M9
G0Z50.
G91G28Z0.
G28A0.
G28Y0.
M30
%
