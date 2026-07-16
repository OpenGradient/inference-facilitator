import base64
sig_b64 = 'JQ3O2FZ4wLJ14MmfwTmna/gohfqo3lbRSe6d68Cx4hNPuWoVJXXamwNZGgxNCGybEkeZGeZprL5Z1iK7ymtahpH0BSTPV1PQNMLTHaDj/0NT8kdnwSMc5ai7gBFOKliGskuwJ1dsfDYSveMfgF+pJMVv/spX/wuct7QXRDMyDVaWS65awkBfxmJRX9n/1f/fpSFoxy7cTHkUEz1XIGqZ3/8iDWClP+YKLKaO4mYTkS8vcIBg3fwi2YDOMHQ0uoRTXPetXrPrtPlD2Asi5faRK0FkRdae1Zq1DAFxzIxuPL2msUJfSu/UMV+6Yysg5VeypuDDR4OouWC+1WeBFkMn0g==' 
sig_bytes = base64.b64decode(sig_b64)
print('hex:', sig_bytes.hex())
print('length:', len(sig_bytes), 'bytes')
