# Homemade-Toolbox
A version of Docker software I made myself, including some commonly used small tools, hope it can help you!
(This article was written using Microsoft Translator. If you want to see the Chinese document, you can check the '[README (CN)](https://github.com/huang9684/Homemade-Toolbox/blob/main/README（CN）.md)' document.)
（本篇采用微软翻译编写，若您希望看到中文文档，可查看“[README（CN）](https://github.com/huang9684/Homemade-Toolbox/blob/main/README（CN）.md)”文档。）

### Way of working
Its working method is as follows ：
```code
toolbox-docker/
├── Dockerfile ← Multi-stage build image
├── package.json ← Dependency declaration
├── server.js ← Backend service
└── public/
└── index.html ← Frontend page
```

### How to use this project?
You can download this project and then build your DOCKER image using the following command:
```code
# Build (we assume you are operating in the download directory [the author uses Windows 
system, if you are using another system you need to change the slash to the opposite])
docker build -t toolbox:latest .toolbox-docker

# Load an image
docker load -i image_name.tar

# This command will import the image into the local Docker environment but will not automatically attach a tag.
# Add a tag
docker tag <IMAGE_ID> <REPOSITORY>:<TAG>
docker tag abc12345 myrepo/myimage:latest

# Run (xxxx is the port you set yourself, the port can be modified freely)
docker run -d -p xxxx:3000 --name toolbox toolbox:latest
```
If you do not want to build it yourself, we have also prepared a pre-packaged DOCKER image for you, which can be deployed directly after downloading,You can find the file on the 'Publish' page.
