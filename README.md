# Molecule to ASCII

```bash
>curl "https://mol2txt.app?smi=O(c1ccccc1C\C=C)CC(O)CNC(C)C"

        C         C
        │         ║
        C─O     C─C
          │     │
  C   N   C   O C
   ╲ ╱ ╲ ╱ ╲ ╱│╱╲╲
    C   C   C C   C
    │         ║   │
    C         C─C═C

>curl "https://mol2txt.app?name=(RS)-1-(propan-2-ylamino)-3-(1-naphthyloxy)propan-2-ol"
    C
    │
    C
   /│
  C N
    │
    C   O
     ╲ /
      C
      │
      C─O
        │
    C   C
    ║╲ / ╲
    C C   C
    │ │   │
    C═C─C═C

>curl "http://localhost:8787?smi=CC(C)NCC(COC1=CC=CC=C1CC=C)OCC&format=png" --output mol.png
```