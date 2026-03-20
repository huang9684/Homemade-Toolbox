# 自制工具箱
（本篇由作者编写，若您希望看到英文文档，可查看“[README](https://github.com/huang9684/Homemade-Toolbox/blob/main/README.md)”文档。）
(This article is written by the author. If you wish to see the English document, you can refer to the '[README](https://github.com/huang9684/Homemade-Toolbox/blob/main/README.md)' file.)

### 工作方式
它的工作方式如下：
```code
toolbox-docker/
├── Dockerfile          ← 多阶段构建镜像
├── package.json        ← 依赖声明
├── server.js           ← 后端服务
└── public/
    └── index.html      ← 前端页面
```

### 如何使用此项目？
您可将本项目下载后，通过下列命令来构建您的DOCKER镜像：
```code
# 构建（我们假设您在下载目录进行操作【作者采用Windows系统进行操作，若您为其他系统需修改斜杠为相反】）
docker build -t toolbox:latest .\toolbox-docker

# 加载镜像
docker load -i 镜像名.tar

# 命令会将镜像导入到本地 Docker 环境中，但不会自动附加标签。
# 添加tag标签 
docker tag <IMAGE_ID> <REPOSITORY>:<TAG>
docker tag abc12345 myrepo/myimage:latest

# 运行（xxxx为您自行设定的端口，端口可自行修改）
docker run -d -p xxxx:3000 --name toolbox toolbox:latest
```
若您不想进行构建，我们也为您准备了已经打包好的DOCKER镜像，下载后即可直接进行部署。
