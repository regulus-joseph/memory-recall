#!/bin/bash
cd /home/marlon-wei/projects/memory-recall
/home/marlon-wei/bin/python3 src/worker.py &
exec /home/marlon-wei/bin/python3 src/server.py
