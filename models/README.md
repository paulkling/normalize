# Model weights

Place the Q4_K_M GGUF here as `normalize-v1.gguf` (about 462 MiB). It is git-ignored.

```
pip install -U huggingface_hub
hf download superwhisper/s1-mini-GGUF --include "*Q4_K_M*.gguf" --local-dir ./models
mv models/*Q4_K_M*.gguf models/normalize-v1.gguf
```

Keep the upstream `LICENSE` and `NOTICE` files next to the weights (copy them from the Hugging Face repo into this
directory). The upstream name appears only here and in the PRD appendix; the product refers to the model as
`normalize-v1` everywhere else.
