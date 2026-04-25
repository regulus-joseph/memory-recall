#!/bin/bash
cd /home/marlon-wei/projects/memory-recall
# TS plugin spawns worker.py directly via child_process
# start.sh kept for manual testing only
~/.memory-recall-venv/bin/python src/worker.py
