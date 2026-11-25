#!/usr/bin/env bash
set -euo pipefail
# The timestamp gap and two tones distinguish a correct tail edit from a head edit.
ffmpeg=$1
output=$2
"$ffmpeg" -nostdin -v error \
  -f lavfi -i 'testsrc2=size=128x72:rate=25:duration=2.4' \
  -f lavfi -i 'aevalsrc=if(lt(t\,1.4)\,0.25*sin(2*PI*330*t)\,0.25*sin(2*PI*880*t)):s=48000:d=2.4' \
  -vf "select='gte(n,3)*not(eq(n,5))'" -fps_mode vfr -c:v ffv1 -c:a pcm_s16le \
  -fflags +bitexact -flags:v +bitexact -flags:a +bitexact -output_ts_offset 2 "$output"
