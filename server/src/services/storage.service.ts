import { Injectable } from '@nestjs/common';
import { join } from 'node:path';
import { APP_MEDIA_LOCATION } from 'src/constants';
import { StorageCore } from 'src/cores/storage.core';
import { OnEvent, OnJob } from 'src/decorators';
import { DatabaseLock, JobName, JobStatus, QueueName, StorageFolder, SystemMetadataKey } from 'src/enum';
import { BaseService } from 'src/services/base.service';
import { JobOf, SystemFlags } from 'src/types';
import { ImmichStartupError } from 'src/utils/misc';

const docsMessage = `Please see https://immich.app/docs/administration/system-integrity#folder-checks for more information.`;

@Injectable()
export class StorageService extends BaseService {
  @OnEvent({ name: 'AppBootstrap' })
  async onBootstrap() {
    const envData = this.configRepository.getEnv();

    await this.databaseRepository.withLock(DatabaseLock.SystemFileMounts, async () => {
      const flags =
        (await this.systemMetadataRepository.get(SystemMetadataKey.SystemFlags)) ||
        ({ mountChecks: {} } as SystemFlags);

      if (!flags.mountChecks) {
        flags.mountChecks = {};
      }

      let updated = false;

      this.logger.log(`Verifying system mount folder checks, current state: ${JSON.stringify(flags)}`);

      try {
        // check each folder exists and is writable
        for (const folder of Object.values(StorageFolder)) {
          if (!flags.mountChecks[folder]) {
            this.logger.log(`Writing initial mount file for the ${folder} folder`);
            await this.createMountFile(folder);
          }

          await this.verifyReadAccess(folder);
          await this.verifyWriteAccess(folder);

          if (!flags.mountChecks[folder]) {
            flags.mountChecks[folder] = true;
            updated = true;
          }
        }

        if (updated) {
          await this.systemMetadataRepository.set(SystemMetadataKey.SystemFlags, flags);
          this.logger.log('Successfully enabled system mount folders checks');
        }

        this.logger.log('Successfully verified system mount folder checks');
      } catch (error) {
        if (envData.storage.ignoreMountCheckErrors) {
          this.logger.error(error as Error);
          this.logger.warn('Ignoring mount folder errors');
        } else {
          throw error;
        }
      }
    });

    await this.databaseRepository.withLock(DatabaseLock.MediaLocation, async () => {
      const current = APP_MEDIA_LOCATION;
      const savedValue = await this.systemMetadataRepository.get(SystemMetadataKey.MediaLocation);
      let previous = savedValue?.location || '';

      if (previous !== current) {
        this.logger.log(`Media location changed (from=${previous}, to=${current})`);

        const samples = await this.assetRepository.getFileSamples();
        if (samples.length > 0) {
          const originalPath = samples[0].originalPath;
          if (!previous) {
            previous = originalPath.startsWith('upload/') ? 'upload' : '/usr/src/app/upload';
          }

          if (previous && originalPath.startsWith(previous)) {
            this.logger.warn(
              `Detected a change to IMMICH_MEDIA_LOCATION, performing an automatic migration of file paths from ${previous} to ${current}, this may take awhile`,
            );
            await this.databaseRepository.migrateFilePaths(previous, current);
          }
        }

        await this.systemMetadataRepository.set(SystemMetadataKey.MediaLocation, { location: current });
      }
    });
  }

  @OnJob({ name: JobName.FileDelete, queue: QueueName.BackgroundTask })
  async handleDeleteFiles(job: JobOf<JobName.FileDelete>): Promise<JobStatus> {
    const { files } = job;

    // TODO: one job per file
    for (const file of files) {
      if (!file) {
        continue;
      }

      try {
        await this.storageRepository.unlink(file);
      } catch (error: any) {
        this.logger.warn('Unable to remove file from disk', error);
      }
    }

    return JobStatus.Success;
  }

  private async verifyReadAccess(folder: StorageFolder) {
    const { internalPath, externalPath } = this.getMountFilePaths(folder);
    try {
      await this.storageRepository.readFile(internalPath);
    } catch (error) {
      this.logger.error(`Failed to read (${internalPath}): ${error}`);
      throw new ImmichStartupError(`Failed to read: "${externalPath} (${internalPath}) - ${docsMessage}"`);
    }
  }

  private async createMountFile(folder: StorageFolder) {
    const { folderPath, internalPath, externalPath } = this.getMountFilePaths(folder);
    try {
      this.storageRepository.mkdirSync(folderPath);
      await this.storageRepository.createFile(internalPath, Buffer.from(`${Date.now()}`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        this.logger.warn('Found existing mount file, skipping creation');
        return;
      }
      this.logger.error(`Failed to create ${internalPath}: ${error}`);
      throw new ImmichStartupError(`Failed to create "${externalPath} - ${docsMessage}"`);
    }
  }

  private async verifyWriteAccess(folder: StorageFolder) {
    const { internalPath, externalPath } = this.getMountFilePaths(folder);
    try {
      await this.storageRepository.overwriteFile(internalPath, Buffer.from(`${Date.now()}`));
    } catch (error) {
      this.logger.error(`Failed to write ${internalPath}: ${error}`);
      throw new ImmichStartupError(`Failed to write "${externalPath} - ${docsMessage}"`);
    }
  }

  private getMountFilePaths(folder: StorageFolder) {
    const folderPath = StorageCore.getBaseFolder(folder);
    const internalPath = join(folderPath, '.immich');
    const externalPath = `<UPLOAD_LOCATION>/${folder}/.immich`;

    return { folderPath, internalPath, externalPath };
  }
}
