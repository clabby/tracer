# Demo loadgen image (the consensus-sim cluster). buildx bake resolves
# relative paths against the caller's cwd, so invoke from the repository root:
#   docker buildx bake -f docker/demo/docker-bake.hcl
# which is what `just demo` does (it `cd ..`s first).
#
# The web image is built separately from docker/docker-bake.hcl; the demo uses
# that same production image, pointed at the bundled Tempo via TEMPO_URL.

variable "REGISTRY" {
  default = "ghcr.io"
}

variable "REPOSITORY" {
  default = "clabby/tracer"
}

variable "DEFAULT_TAG" {
  default = "local"
}

variable "RUST_TOOLCHAIN" {
  default = "stable"
}

group "default" {
  targets = ["loadgen"]
}

target "loadgen" {
  context = "."
  dockerfile = "docker/demo/Dockerfile.loadgen"
  tags = [
    "tracer-loadgen:${DEFAULT_TAG}",
    "${REGISTRY}/${REPOSITORY}-loadgen:${DEFAULT_TAG}",
  ]
  args = {
    RUST_TOOLCHAIN = RUST_TOOLCHAIN
  }
}
